-- Skills: saved, reusable instruction sets a user can run from chat.
-- A skill runs against the current conversation context and either produces
-- an artifact (e.g. "Generate Quote") or replies inline in the chat.

create type public.skill_output_mode as enum ('artifact', 'reply');

create table public.skills (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  description text,
  instructions text not null default '',
  output_mode public.skill_output_mode not null default 'artifact',
  artifact_type public.artifact_type not null default 'markdown',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index skills_owner_idx on public.skills (owner_id, updated_at desc);

alter table public.skills enable row level security;

create policy "Owners manage their skills"
  on public.skills for all
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

create trigger skills_set_updated_at
  before update on public.skills
  for each row execute function public.set_updated_at();
