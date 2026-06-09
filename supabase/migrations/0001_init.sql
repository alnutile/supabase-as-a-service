-- Intranet schema: profiles, conversations, messages, artifacts, files.
-- Security model: row-level security everywhere. Owners see their own rows;
-- artifacts/files can be opened up to "unlisted" (link) or "public".

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
create type public.visibility as enum ('private', 'unlisted', 'public');
create type public.message_role as enum ('user', 'assistant', 'system');
create type public.artifact_type as enum ('markdown', 'code', 'html', 'text');

-- ---------------------------------------------------------------------------
-- Shared helpers
-- ---------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- profiles (1:1 with auth.users)
-- ---------------------------------------------------------------------------
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text,
  display_name text,
  avatar_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

create policy "Profiles are viewable by their owner"
  on public.profiles for select
  using (id = auth.uid());

create policy "Users can insert their own profile"
  on public.profiles for insert
  with check (id = auth.uid());

create policy "Users can update their own profile"
  on public.profiles for update
  using (id = auth.uid());

create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

-- Auto-create a profile row whenever a new auth user signs up.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, display_name)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'display_name', split_part(new.email, '@', 1))
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Trigger functions should not be callable as PostgREST RPC endpoints.
-- Triggers still fire as the table owner after these revokes.
revoke execute on function public.handle_new_user() from anon, authenticated, public;
revoke execute on function public.set_updated_at() from anon, authenticated, public;

-- ---------------------------------------------------------------------------
-- conversations
-- ---------------------------------------------------------------------------
create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  title text not null default 'New chat',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index conversations_owner_idx on public.conversations (owner_id, updated_at desc);

alter table public.conversations enable row level security;

create policy "Owners manage their conversations"
  on public.conversations for all
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

create trigger conversations_set_updated_at
  before update on public.conversations
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- messages
-- ---------------------------------------------------------------------------
create table public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  owner_id uuid not null references auth.users (id) on delete cascade,
  role public.message_role not null,
  content text not null default '',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index messages_conversation_idx on public.messages (conversation_id, created_at);

alter table public.messages enable row level security;

create policy "Owners manage their messages"
  on public.messages for all
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

-- ---------------------------------------------------------------------------
-- artifacts
-- ---------------------------------------------------------------------------
create table public.artifacts (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  conversation_id uuid references public.conversations (id) on delete set null,
  title text not null default 'Untitled artifact',
  type public.artifact_type not null default 'markdown',
  language text,
  content text not null default '',
  visibility public.visibility not null default 'private',
  public_slug text unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index artifacts_owner_idx on public.artifacts (owner_id, updated_at desc);
create index artifacts_slug_idx on public.artifacts (public_slug) where public_slug is not null;

alter table public.artifacts enable row level security;

-- Owners can do anything with their artifacts; anyone (including anon) can read
-- artifacts that have been shared (unlisted/public).
create policy "Read own or shared artifacts"
  on public.artifacts for select
  using (owner_id = auth.uid() or visibility <> 'private');

create policy "Owners insert artifacts"
  on public.artifacts for insert
  with check (owner_id = auth.uid());

create policy "Owners update artifacts"
  on public.artifacts for update
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

create policy "Owners delete artifacts"
  on public.artifacts for delete
  using (owner_id = auth.uid());

create trigger artifacts_set_updated_at
  before update on public.artifacts
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- files (metadata; bytes live in storage bucket 'files')
-- ---------------------------------------------------------------------------
create table public.files (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  bucket text not null default 'files',
  path text not null,
  name text not null,
  mime_type text,
  size_bytes bigint,
  visibility public.visibility not null default 'private',
  public_slug text unique,
  created_at timestamptz not null default now()
);

create index files_owner_idx on public.files (owner_id, created_at desc);

alter table public.files enable row level security;

create policy "Owners manage their files"
  on public.files for all
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

-- ---------------------------------------------------------------------------
-- Realtime: broadcast inserts/updates so chat updates live across devices.
-- ---------------------------------------------------------------------------
alter publication supabase_realtime add table public.messages;
alter publication supabase_realtime add table public.conversations;

-- ---------------------------------------------------------------------------
-- Storage: a private bucket for user files. Objects live under <user-id>/...
-- so each user can only touch their own folder. Sharing is done with signed
-- URLs created by the owner (see the Files page).
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('files', 'files', false)
on conflict (id) do nothing;

create policy "Users read their own files"
  on storage.objects for select
  using (bucket_id = 'files' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "Users upload to their own folder"
  on storage.objects for insert
  with check (bucket_id = 'files' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "Users update their own files"
  on storage.objects for update
  using (bucket_id = 'files' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "Users delete their own files"
  on storage.objects for delete
  using (bucket_id = 'files' and (storage.foldername(name))[1] = auth.uid()::text);
