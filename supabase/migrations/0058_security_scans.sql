-- Security dashboard (Governance → Security): the "audit the workspace" scan
-- as a first-class, repeatable feature instead of a one-off conversation.
--
-- HISTORY NOTE: this file first shipped as 0056_security_scans.sql, colliding
-- with 0056_conversation_pinned.sql — `db push` derives versions from the
-- numeric prefix, so the duplicate meant THIS migration was never applied to
-- the live project (the tables and the seeded tool silently didn't exist, and
-- the dashboard's "Run scan" button had nothing to call). Renumbered to 0058
-- and written idempotently (if-not-exists guards everywhere) so it applies
-- cleanly whether or not some environment already ran the old file.
--
-- A `security_scans` row is one run of the posture scan; `security_findings`
-- are its actionable items. The scan itself is the seeded `run_security_scan`
-- builtin (handler in supabase/functions/_shared/security.ts): DETERMINISTIC
-- checks over workspace configuration — webhooks without secrets, agent-enabled
-- webhooks, guardrail coverage, exfiltration-capable tools, vault/document/
-- artifact sharing posture, stale MCP tokens — plus ONE optional utility-model
-- call that writes the run's prose summary (fails open to a deterministic
-- summary; the findings themselves never depend on the model).
--
-- LIVE PROGRESS: the scan can take several seconds (config queries + the
-- summary model call), so the row carries a `progress` jsonb — an ordered list
-- of steps `{key, label, status: pending|running|done}` the builtin updates as
-- it works — and `security_scans` joins the `supabase_realtime` publication.
-- The dashboard subscribes and renders the running scan's checklist live
-- instead of leaving the admin staring at a disabled button.
--
-- Because it's an ordinary builtin tools row, every existing trigger surface
-- works with zero new plumbing: the dashboard's "Run scan" button calls it via
-- the universal `run-tool` function; a daily run is just an agent scoped to
-- this tool on a `schedules` row; chat can run it on request. The builtin
-- re-checks profiles.is_admin in code (defense in depth on top of the
-- admin-only dashboard), so a non-admin caller of run-tool gets a refusal.
--
-- Findings carry a STABLE `key` (e.g. 'webhook_no_secret:<id>') so a re-run
-- carries a previously dismissed/promoted status forward instead of nagging
-- about the same accepted risk every day. "Promote" files the finding onto the
-- Features board (`feature_id`) in the idea lane — from there the existing
-- human-approval drag pipeline takes over and the fix gets built like any
-- other feature.

create table if not exists public.security_scans (
  id uuid primary key default gen_random_uuid(),
  status text not null default 'running' check (status in ('running', 'ok', 'error')),
  summary text not null default '',
  findings_count integer not null default 0,
  error text,
  triggered_by uuid references auth.users (id) on delete set null,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);

-- Live step checklist for the run (see header). Added separately so an
-- environment that ran the old 0056 file picks it up too.
alter table public.security_scans
  add column if not exists progress jsonb not null default '[]'::jsonb;

create table if not exists public.security_findings (
  id uuid primary key default gen_random_uuid(),
  scan_id uuid not null references public.security_scans (id) on delete cascade,
  key text not null,               -- stable check identity for status carry-over across runs
  severity text not null check (severity in ('critical', 'high', 'medium', 'low', 'info')),
  title text not null,
  detail text not null default '',
  suggestion text not null default '',
  status text not null default 'open' check (status in ('open', 'dismissed', 'promoted')),
  feature_id uuid references public.features (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists security_findings_scan_idx on public.security_findings (scan_id);
create index if not exists security_findings_key_idx on public.security_findings (key, created_at desc);

alter table public.security_scans enable row level security;
alter table public.security_findings enable row level security;

-- Findings enumerate the workspace's weak points, so the whole area is
-- admin-only (same posture as Vault/Guardrails). Rows are WRITTEN by the
-- service role (the scan builtin); admins only update finding status
-- (dismiss / promote) from the dashboard.
drop policy if exists "Admins read security scans" on public.security_scans;
create policy "Admins read security scans"
  on public.security_scans for select
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin));

drop policy if exists "Admins read security findings" on public.security_findings;
create policy "Admins read security findings"
  on public.security_findings for select
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin));

drop policy if exists "Admins update security findings" on public.security_findings;
create policy "Admins update security findings"
  on public.security_findings for update
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin))
  with check (exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin));

-- Realtime: the dashboard follows the running scan row (insert + progress
-- updates + the final ok/error flip) over the supabase_realtime publication,
-- like messages/conversations/artifacts before it. RLS still gates who
-- receives the events (admins only, per the select policy above).
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'security_scans'
  ) then
    alter publication supabase_realtime add table public.security_scans;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Seed the scan builtin. Idempotent via `where not exists`.
-- ---------------------------------------------------------------------------
insert into public.tools (name, description, input_schema, kind, is_builtin, is_active, created_by)
select 'run_security_scan',
  'ADMIN ONLY: run the workspace security posture scan. Deterministic checks over configuration (webhooks without shared secrets, agent-enabled webhooks, guardrail coverage, exfiltration-capable tools like send_email/get_secret/MCP servers, workspace-shared vault secrets, public artifacts, stale MCP tokens) write actionable findings to the Security dashboard (Governance → Security). Returns a summary of what was found. Non-admin callers are refused.',
  '{"type":"object","properties":{}}'::jsonb,
  'builtin', true, true,
  (select id from public.profiles order by created_at asc limit 1)
where not exists (select 1 from public.tools where name = 'run_security_scan');
