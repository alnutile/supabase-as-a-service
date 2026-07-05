-- Security dashboard (Governance → Security): the "audit the workspace" scan
-- as a first-class, repeatable feature instead of a one-off conversation.
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

create table public.security_scans (
  id uuid primary key default gen_random_uuid(),
  status text not null default 'running' check (status in ('running', 'ok', 'error')),
  summary text not null default '',
  findings_count integer not null default 0,
  error text,
  triggered_by uuid references auth.users (id) on delete set null,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);

create table public.security_findings (
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
create index security_findings_scan_idx on public.security_findings (scan_id);
create index security_findings_key_idx on public.security_findings (key, created_at desc);

alter table public.security_scans enable row level security;
alter table public.security_findings enable row level security;

-- Findings enumerate the workspace's weak points, so the whole area is
-- admin-only (same posture as Vault/Guardrails). Rows are WRITTEN by the
-- service role (the scan builtin); admins only update finding status
-- (dismiss / promote) from the dashboard.
create policy "Admins read security scans"
  on public.security_scans for select
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin));

create policy "Admins read security findings"
  on public.security_findings for select
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin));

create policy "Admins update security findings"
  on public.security_findings for update
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin))
  with check (exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin));

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
