-- Repository snapshots reuse the existing Secrets vault and its access rules.
create table public.collection_repositories (
  id uuid primary key default gen_random_uuid(),
  collection_id uuid not null references public.collections(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  vault_secret_id uuid references public.vault_secrets(id) on delete set null,
  repository text not null,
  branch text not null default '',
  path_prefix text not null default '',
  status text not null default 'pending' check (status in ('pending','syncing','ready','error')),
  commit_sha text,
  synced_at timestamptz,
  sync_started_at timestamptz,
  run_id uuid,
  error text,
  files jsonb not null default '[]'::jsonb,
  file_count integer not null default 0,
  omitted_count integer not null default 0,
  created_at timestamptz not null default now(),
  unique(collection_id, repository, branch, path_prefix)
);
create index collection_repositories_collection_idx on public.collection_repositories(collection_id);
alter table public.collection_repositories enable row level security;
revoke all on public.collection_repositories from anon, authenticated;
grant select on public.collection_repositories to authenticated;
grant all on public.collection_repositories to service_role;
create policy "Read collection repositories" on public.collection_repositories for select to authenticated
using (exists(select 1 from public.collections c where c.id = collection_id));
-- Mutations go through the authenticated edge function, which checks ownership.

