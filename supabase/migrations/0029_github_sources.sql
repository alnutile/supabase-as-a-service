-- GitHub as a knowledge source: sync a repo's docs/spec files (and optionally its
-- issues & PRs) into the workspace knowledge base so the team's chat can search
-- them via the existing `search_documents` tool.
--
-- This reuses the whole RAG pipeline. A new public `github-webhook` edge function
-- (verify_jwt=false, token-gated like `webhook`/`email-inbound`, with GitHub's
-- HMAC signature as real auth) receives `push`/`issues`/`pull_request` events,
-- fetches the changed files' contents from the GitHub API, and STAGES them as
-- `documents` rows (source='github', status='processing') with un-embedded chunks.
-- The existing `ingest` cron's EMBED phase then fills the gte-small embeddings —
-- the same resumable, compute-safe path PDFs use. Nothing about retrieval changes:
-- github docs default to scope='workspace', so RLS + match_document_chunks already
-- make them searchable alongside PDFs and notes.

-- 1) Documents can now come from GitHub, and carry a stable external ref so a
--    re-pushed file UPDATES its document in place instead of duplicating.
alter table public.documents
  drop constraint if exists documents_source_check;
alter table public.documents
  add constraint documents_source_check check (source in ('pdf', 'note', 'github'));

alter table public.documents
  add column if not exists source_ref text;  -- e.g. 'owner/repo:docs/guide.md@main' or 'owner/repo#issues/42'
create index if not exists documents_source_ref_idx on public.documents (source_ref) where source_ref is not null;

-- 2) Per-repo configuration. Owner-managed, mirroring `webhooks`. The URL `token`
--    is secret-URL security; an optional GitHub `secret` (HMAC) adds real auth.
--    A GitHub PAT (for private repos) is NEVER stored as a column — only a Vault
--    pointer (`pat_secret_id`), set through the security-definer RPC below, same
--    posture as the email integration.
create table public.github_sources (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  name text not null default 'New GitHub source',
  repo text not null default '',                                   -- 'owner/name'
  branch text not null default 'main',
  include_globs text[] not null default array['**/*.md', '**/*.mdx', 'docs/**'],
  ingest_issues boolean not null default true,                     -- also index issues & PRs
  scope text not null default 'workspace' check (scope in ('workspace', 'private')),
  token uuid not null default gen_random_uuid() unique,            -- opaque URL token
  secret text,                                                     -- GitHub webhook HMAC secret (plaintext, like webhooks.secret)
  pat_secret_id uuid,                                              -- vault.secrets.id holding a GitHub PAT (private repos)
  is_active boolean not null default true,
  last_synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index github_sources_owner_idx on public.github_sources (owner_id);
create index github_sources_token_idx on public.github_sources (token);

alter table public.github_sources enable row level security;
create policy "Owners manage their github sources"
  on public.github_sources for all
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());

-- 3) A live log of inbound events / syncs, mirroring `webhook_events`.
create table public.github_events (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null references public.github_sources (id) on delete cascade,
  event_type text not null,                                        -- push | issues | pull_request | issue_comment | sync | ping
  status text not null,                                            -- received | ok | error | skipped
  summary text,
  detail jsonb,
  created_at timestamptz not null default now()
);
create index github_events_source_idx on public.github_events (source_id, created_at desc);

alter table public.github_events enable row level security;
create policy "Owners read their github events"
  on public.github_events for select
  using (exists (
    select 1 from public.github_sources g
    where g.id = source_id and g.owner_id = auth.uid()
  ));
-- Writes happen via the github-webhook function (service role); no client write policy.

-- Live updates for the UI log.
alter publication supabase_realtime add table public.github_events;

-- 4) Vault RPCs for the optional GitHub PAT. Owner-checked INSIDE the body (UI
--    gating is cosmetic). The key is write-only: an empty key clears the pointer.
create extension if not exists supabase_vault;

create or replace function public.set_github_source_pat(p_source_id uuid, p_pat text)
returns void
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  v_src public.github_sources;
  v_secret_id uuid;
begin
  select * into v_src from public.github_sources where id = p_source_id;
  if v_src.id is null then
    raise exception 'No such GitHub source';
  end if;
  if v_src.owner_id <> auth.uid() then
    raise exception 'You can only set a token on your own GitHub source';
  end if;

  if coalesce(trim(p_pat), '') = '' then
    -- Clear the PAT (drop the pointer; the orphaned secret is harmless).
    update public.github_sources set pat_secret_id = null, updated_at = now() where id = p_source_id;
    return;
  end if;

  if v_src.pat_secret_id is null then
    v_secret_id := vault.create_secret(
      p_pat,
      'github_pat_' || replace(gen_random_uuid()::text, '-', ''),
      'GitHub PAT for github_source ' || p_source_id
    );
    update public.github_sources set pat_secret_id = v_secret_id, updated_at = now() where id = p_source_id;
  else
    perform vault.update_secret(v_src.pat_secret_id, p_pat);
    update public.github_sources set updated_at = now() where id = p_source_id;
  end if;
end;
$$;
revoke execute on function public.set_github_source_pat(uuid, text) from anon, public;
grant execute on function public.set_github_source_pat(uuid, text) to authenticated;

-- Service-role-only reader of the decrypted PAT (the edge function calls this).
-- Execute revoked from API roles, mirroring read_email_secret / match_document_chunks.
create or replace function public.read_github_source_pat(p_source_id uuid)
returns text
language sql
stable
security definer
set search_path = public, vault
as $$
  select s.decrypted_secret
  from public.github_sources g
  join vault.decrypted_secrets s on s.id = g.pat_secret_id
  where g.id = p_source_id;
$$;
revoke execute on function public.read_github_source_pat(uuid) from anon, authenticated, public;

-- 5) Nudge the assistant to reach for search for code/spec/docs questions too.
update public.tools
set description = 'Search the workspace''s shared knowledge base — uploaded documents, pushed notes (meeting notes/transcripts), and docs/spec files synced from GitHub — plus the user''s own private documents. Use whenever the user asks about the content of files, documents, meetings, notes, or how the team builds things.'
where name = 'search_documents' and is_builtin;
