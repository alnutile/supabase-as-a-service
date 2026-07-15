-- Capability-worker jobs — the durable queue that lets the main SupaNet AI hand
-- focused, heavy work to specialized Docker workers instead of running big
-- binaries inside the app. The first two workers are OfficeCLI (Word/Excel/
-- PowerPoint) and ffmpeg (audio/video); the pattern is reusable for PDF/OCR/
-- browser/etc. later.
--
-- Deliberately NOT an `agents` table / registry (see the build handoff): the
-- capability CONTRACT lives in skills, the execution layer is a container
-- (Railway is the first deploy target, not a dependency — the protocol is just
-- Postgres + Storage + env vars), and this one `agent_jobs` table is the
-- coordination point. Flow:
--   main AI → loads a capability skill → inserts an agent_jobs row (queued) →
--   a worker claims it atomically → downloads inputs from Storage →
--   runs the library → uploads outputs → writes result_manifest → marks it
--   completed → main AI reads the manifest and continues. IDs and manifests
--   move through the system, never large files through the prompt.
--
-- Shape follows existing conventions rather than inventing new ones:
--   * own-or-admin RLS (mirrors activity_log / usage_events); workers run as the
--     service role, which bypasses RLS, and re-scope inputs to the requester in
--     code.
--   * emit_event agent_job.created / agent_job.updated (0063) so listeners can
--     react ("when a media job completes, …").
--   * seeded is_builtin tools create_agent_job / get_agent_job / list_agent_jobs
--     / cancel_agent_job so chat + all three agent loops + the MCP server can
--     queue and poll work through one code path.
--   * three seeded always-on skills teach the assistant the pattern
--     (capability-worker-jobs) and the two capabilities (office-document-worker,
--     media-ffmpeg-worker).

-- ---------------------------------------------------------------------------
-- agent_jobs
-- ---------------------------------------------------------------------------
create table public.agent_jobs (
  id uuid primary key default gen_random_uuid(),
  -- Single-workspace app today; kept for forward-compat + worker ownership
  -- checks. Nullable so the current UI/builtins don't have to synthesize one.
  workspace_id uuid,
  conversation_id uuid references public.conversations (id) on delete set null,
  requested_by uuid references auth.users (id) on delete set null,
  capability text not null check (capability in ('office', 'media')),
  operation text not null,
  status text not null default 'queued'
    check (status in ('queued','claimed','running','completed','failed','retrying','cancelled','dead_letter')),
  priority integer not null default 50,
  instructions text,
  -- References to inputs (file_id / artifact_id / storage_path + role), never
  -- file contents. The worker verifies every input belongs to the job's owner.
  input_manifest jsonb not null default '[]'::jsonb,
  -- Operation-specific knobs (e.g. ffmpeg timestamps/format).
  parameters jsonb not null default '{}'::jsonb,
  -- What the worker produced: files + artifacts with roles.
  result_manifest jsonb,
  error text,
  worker_id text,
  attempts integer not null default 0,
  max_attempts integer not null default 3,
  -- Set when re-running the same op would duplicate outputs; unique per owner.
  idempotency_key text,
  error_code text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  heartbeat_at timestamptz,
  -- Lease: a claimed job is "leased" until this time; if the worker dies without
  -- heartbeating past it, recover_stale_agent_jobs reclaims the job. Provider-
  -- neutral (no Railway APIs) — the lease is just a timestamp in Postgres.
  lease_expires_at timestamptz,
  -- Retry/backoff gate: a claimable job needs available_at null or in the past.
  available_at timestamptz,
  cancelled_at timestamptz,
  updated_at timestamptz not null default now()
);

-- The claim query orders by priority desc, created_at asc and filters by
-- capability + status + available_at — index that path.
create index agent_jobs_claim_idx
  on public.agent_jobs (capability, status, priority desc, created_at asc);
create index agent_jobs_requested_by_idx on public.agent_jobs (requested_by, created_at desc);
create index agent_jobs_status_idx on public.agent_jobs (status);
-- Lease recovery scans running/claimed jobs by lease expiry.
create index agent_jobs_lease_idx on public.agent_jobs (lease_expires_at)
  where status in ('claimed', 'running');
-- Idempotency: one live job per (owner, key). Partial so null keys don't collide
-- and finished/cancelled jobs don't block a fresh identical request.
create unique index agent_jobs_idempotency_uidx
  on public.agent_jobs (requested_by, idempotency_key)
  where idempotency_key is not null
    and status in ('queued','claimed','running','retrying');

alter table public.agent_jobs enable row level security;
grant select, insert on public.agent_jobs to authenticated;

-- Read your own jobs; admins see all (mirrors activity_log / usage_events).
create policy "Read own or admin agent jobs"
  on public.agent_jobs for select
  using (
    requested_by = auth.uid()
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin)
  );

-- A signed-in member may enqueue jobs as themselves. All state transitions after
-- that (claim/running/complete/fail) are the worker's job and run as the service
-- role, which bypasses RLS — so there is deliberately no client UPDATE policy.
create policy "Insert own agent jobs"
  on public.agent_jobs for insert
  with check (requested_by = auth.uid());

create trigger agent_jobs_set_updated_at
  before update on public.agent_jobs
  for each row execute function public.set_updated_at();

-- Live job status for the UI / a watching main AI (RLS-scoped).
alter publication supabase_realtime add table public.agent_jobs;

-- ---------------------------------------------------------------------------
-- Atomic claim — two workers must never receive the same job. Selects the
-- highest-priority eligible row FOR UPDATE SKIP LOCKED and flips it to claimed
-- in one statement. SECURITY DEFINER + granted to service_role only (workers).
-- ---------------------------------------------------------------------------
create or replace function public.claim_agent_job(
  p_capability text,
  p_worker_id text,
  p_lease_seconds integer default 120
)
returns setof public.agent_jobs
language plpgsql security definer set search_path = public as $$
begin
  return query
  update public.agent_jobs
  set
    status = 'claimed',
    worker_id = p_worker_id,
    started_at = now(),
    heartbeat_at = now(),
    lease_expires_at = now() + make_interval(secs => greatest(p_lease_seconds, 30)),
    attempts = attempts + 1,
    available_at = null
  where id = (
    select j.id
    from public.agent_jobs j
    where j.capability = p_capability
      and j.status in ('queued', 'retrying')
      and (j.available_at is null or j.available_at <= now())
    order by j.priority desc, j.created_at asc
    for update skip locked
    limit 1
  )
  returning *;
end; $$;

revoke execute on function public.claim_agent_job(text, text, integer) from anon, authenticated, public;
grant execute on function public.claim_agent_job(text, text, integer) to service_role;

-- ---------------------------------------------------------------------------
-- Lease recovery — reclaim jobs whose worker died mid-run (lease expired without
-- a heartbeat extending it). Under max_attempts → back to retrying; otherwise
-- dead_letter. A pg_cron tick or any worker can call it. p_lease_seconds is a
-- grace fallback for rows that predate a lease.
-- ---------------------------------------------------------------------------
create or replace function public.recover_stale_agent_jobs(p_lease_seconds integer default 120)
returns integer
language plpgsql security definer set search_path = public as $$
declare
  v_count integer;
begin
  with stale as (
    select id from public.agent_jobs
    where status in ('claimed', 'running')
      and coalesce(lease_expires_at, heartbeat_at + make_interval(secs => p_lease_seconds)) < now()
    for update skip locked
  )
  update public.agent_jobs j
  set
    status = case when j.attempts >= j.max_attempts then 'dead_letter' else 'retrying' end,
    error = coalesce(j.error, 'Worker lease expired (no heartbeat); job recovered.'),
    error_code = coalesce(j.error_code, 'lease_expired'),
    worker_id = null,
    available_at = case when j.attempts >= j.max_attempts then j.available_at else now() end,
    heartbeat_at = null,
    lease_expires_at = null
  from stale
  where j.id = stale.id;
  get diagnostics v_count = row_count;
  return v_count;
end; $$;

revoke execute on function public.recover_stale_agent_jobs(integer) from anon, authenticated, public;
grant execute on function public.recover_stale_agent_jobs(integer) to service_role;

-- ---------------------------------------------------------------------------
-- agent_job_events — an append-only lifecycle/progress log per job (claimed,
-- running, progress, heartbeat is NOT logged to avoid noise, completed, failed,
-- retrying, cancelled, dead_letter). Distinct from the workspace `events` table
-- (0063): those are cross-entity automation signals; this is the job's own
-- timeline the UI/AI can show. Workers insert via the service role.
-- ---------------------------------------------------------------------------
create table public.agent_job_events (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.agent_jobs (id) on delete cascade,
  event_type text not null,
  worker_id text,
  message text,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index agent_job_events_job_idx on public.agent_job_events (job_id, created_at);

alter table public.agent_job_events enable row level security;
grant select on public.agent_job_events to authenticated;

-- Visible to whoever can see the parent job (owner or admin); writes are
-- service-role only (the workers).
create policy "Read events of visible jobs"
  on public.agent_job_events for select
  using (
    exists (
      select 1 from public.agent_jobs j
      where j.id = job_id
        and (
          j.requested_by = auth.uid()
          or exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin)
        )
    )
  );

alter publication supabase_realtime add table public.agent_job_events;

-- ---------------------------------------------------------------------------
-- Events: agent_job.created + agent_job.updated (mirrors 0074/0075). Emits on
-- INSERT and on any status change so listeners can react to lifecycle
-- transitions without polling. Event data is metadata only (no instructions /
-- file contents).
-- ---------------------------------------------------------------------------
create or replace function public.emit_agent_job_event()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'UPDATE' and new.status is not distinct from old.status then
    return new; -- only emit on lifecycle (status) changes, not heartbeats
  end if;
  perform public.emit_event(
    case when tg_op = 'INSERT' then 'agent_job.created' else 'agent_job.updated' end,
    'agent_job', new.id, new.requested_by,
    'Job ' || new.operation || ' → ' || new.status,
    jsonb_build_object('capability', new.capability, 'operation', new.operation, 'status', new.status),
    'private'
  );
  return new;
end; $$;

create trigger trg_emit_agent_job
  after insert or update on public.agent_jobs
  for each row execute function public.emit_agent_job_event();

-- ---------------------------------------------------------------------------
-- Seed the builtins (assistant + all three agent loops + MCP). Same insert shape
-- as 0074/0075; idempotent via `where not exists`.
-- ---------------------------------------------------------------------------
insert into public.tools (name, description, input_schema, kind, is_builtin, is_active, created_by)
select 'create_agent_job',
  'Queue a job for a specialized capability worker (OfficeCLI documents or ffmpeg media) instead of doing heavy binary work yourself. Pass `operation` (e.g. office.create_docx, media.extract_frames — the capability is inferred from the prefix), an `input_manifest` array referencing files by file_id/artifact_id/storage_path (NOT file contents), `instructions`, and optional operation `parameters`. Returns the job id; poll it with get_agent_job. A durable job is created and a Railway worker runs it.',
  '{"type":"object","properties":{"operation":{"type":"string","description":"e.g. office.inspect_document, office.render_document, office.create_docx, media.probe, media.extract_audio, media.extract_frames, media.create_thumbnail, media.transcode, media.clip"},"instructions":{"type":"string","description":"Natural-language instructions for the worker."},"input_manifest":{"type":"array","description":"Input references: each {file_id?|artifact_id?|storage_path?, role?, required?}.","items":{"type":"object","properties":{"file_id":{"type":"string"},"artifact_id":{"type":"string"},"storage_path":{"type":"string"},"role":{"type":"string"},"required":{"type":"boolean"}}}},"parameters":{"type":"object","description":"Operation-specific parameters (e.g. timestamps [0,15], format png)."},"conversation_id":{"type":"string","description":"Optional conversation this job belongs to."},"priority":{"type":"number","description":"0-100, default 50 (higher runs first)."}},"required":["operation"]}'::jsonb,
  'builtin', true, true,
  (select id from public.profiles order by created_at asc limit 1)
where not exists (select 1 from public.tools where name = 'create_agent_job');

insert into public.tools (name, description, input_schema, kind, is_builtin, is_active, created_by)
select 'get_agent_job',
  'Check a capability-worker job by id: its status, error (if any), and — when completed — its result manifest of output files/artifacts. Poll this after create_agent_job until the status is completed, failed, cancelled, or dead_letter.',
  '{"type":"object","properties":{"id":{"type":"string","description":"The job id returned by create_agent_job."}},"required":["id"]}'::jsonb,
  'builtin', true, true,
  (select id from public.profiles order by created_at asc limit 1)
where not exists (select 1 from public.tools where name = 'get_agent_job');

insert into public.tools (name, description, input_schema, kind, is_builtin, is_active, created_by)
select 'list_agent_jobs',
  'List your capability-worker jobs, most recent first, with ids and statuses. Optionally filter by capability (office|media) or status.',
  '{"type":"object","properties":{"capability":{"type":"string","enum":["office","media"]},"status":{"type":"string"},"limit":{"type":"number","description":"Max rows (default 20, max 100)."}}}'::jsonb,
  'builtin', true, true,
  (select id from public.profiles order by created_at asc limit 1)
where not exists (select 1 from public.tools where name = 'list_agent_jobs');

insert into public.tools (name, description, input_schema, kind, is_builtin, is_active, created_by)
select 'cancel_agent_job',
  'Cancel a queued or in-flight capability-worker job you own (by id). Already-completed jobs are unaffected.',
  '{"type":"object","properties":{"id":{"type":"string","description":"The job id to cancel."}},"required":["id"]}'::jsonb,
  'builtin', true, true,
  (select id from public.profiles order by created_at asc limit 1)
where not exists (select 1 from public.tools where name = 'cancel_agent_job');

-- ---------------------------------------------------------------------------
-- Seed the skills. All three are always-on (auto_apply) so the assistant knows
-- the worker pattern exists and can route to the right capability. Kept concise.
-- ---------------------------------------------------------------------------
insert into public.skills (owner_id, name, description, instructions, auto_apply, is_builtin, output_mode)
select
  (select id from public.profiles order by created_at asc limit 1),
  'Capability worker jobs',
  'Built-in. Teaches the assistant the shared worker-job lifecycle: when to hand heavy binary work to a Railway worker via an agent_jobs row, how to build the manifest, and how to read the result.',
  $prompt$CAPABILITY WORKER JOBS (the shared pattern)

Some work should NOT run inside the chat: producing/reading Office documents (Word/Excel/PowerPoint) and processing media (audio/video). Those run in specialized Railway "workers". You hand them a durable job with the `create_agent_job` tool, then poll `get_agent_job` for the result. You pass IDs and manifests — never large binary files through the conversation.

Use a worker when the task: needs a specialized binary/library (OfficeCLI, ffmpeg); involves binary files; may take more than a few seconds; produces multiple assets; or should be retryable and isolated.

Do NOT use a worker when: it's simple text generation; you only need to read a small text file; an existing SupaNet tool already does it; or the user needs an immediate conversational answer with no external processing.

Lifecycle:
1. Identify the capability + operation (e.g. office.create_docx, media.extract_frames). The capability is the prefix (office|media).
2. Build an `input_manifest`: an array of references — each `{file_id}` (preferred), `{artifact_id}`, or `{storage_path}`, plus a `role` ("template"/"reference"/"source_video"…) and `required`. Reference files by ID; never paste their contents. Files come from the Files feature (list_files) or attachments.
3. Call `create_agent_job` with the operation, instructions, input_manifest, and any operation `parameters`. It returns a job id.
4. Poll `get_agent_job` with that id until status is completed / failed / cancelled / dead_letter. It's fine to tell the user "working on it" and check back.
5. On completed, read the result manifest (output files + artifacts with roles). Summarize what was created, offer the editable file + preview, and continue (create/update an artifact, run another job, or — only with explicit approval — share externally).
6. On failed/dead_letter, explain the error in plain language and suggest the next action (e.g. a supported file type).

For the specific operations and payloads, see the "Office document worker" and "Media (ffmpeg) worker" skills.$prompt$,
  true,
  true,
  'reply'
where not exists (select 1 from public.skills where name = 'Capability worker jobs' and is_builtin = true);

insert into public.skills (owner_id, name, description, instructions, auto_apply, is_builtin, output_mode)
select
  (select id from public.profiles order by created_at asc limit 1),
  'Office document worker',
  'Built-in. OfficeCLI capability (capability=office): inspect, render, create, and convert Word/Excel/PowerPoint documents via a Railway worker.',
  $prompt$OFFICE DOCUMENT WORKER (capability = office)

Handles Word/Excel/PowerPoint work. Uses the shared "Capability worker jobs" lifecycle; this adds the office operations. Create jobs with create_agent_job.

Operations:
- office.inspect_document — read a docx/xlsx/pptx and return structured JSON + a markdown summary (+ optional preview). Use when the user asks "what's in this document / summarize this spreadsheet".
- office.render_document — turn a docx/xlsx/pptx into PNG/HTML/PDF previews. Use for "show me / preview this".
- office.create_docx — create an editable DOCX from a template + reference files + instructions; returns the DOCX, a rendered PNG preview, and a validation report artifact. Use for "draft the next proposal like this one".
- office.convert_document — convert a document to another office/PDF format.

Input manifest roles: `template` (required for create_docx), `reference`, `source` (for inspect/render/convert). Reference by file_id.

Example (create_docx):
create_agent_job({
  operation: "office.create_docx",
  instructions: "Create a proposal for Acme using the template structure. Use the provided rate card. Include discovery, timeline, three pricing tiers, and standard payment terms.",
  input_manifest: [ {file_id:"<template>", role:"template", required:true}, {file_id:"<rate-card>", role:"reference", required:true} ]
})

Confirmation: creating/converting a document is safe (it only writes to Files/Storage) — no confirmation needed. Only sharing the result externally (email/etc.) needs explicit approval. When done, offer the editable file, show the preview, and give the short validation report.$prompt$,
  true,
  true,
  'reply'
where not exists (select 1 from public.skills where name = 'Office document worker' and is_builtin = true);

insert into public.skills (owner_id, name, description, instructions, auto_apply, is_builtin, output_mode)
select
  (select id from public.profiles order by created_at asc limit 1),
  'Media (ffmpeg) worker',
  'Built-in. ffmpeg capability (capability=media): probe media and extract audio/frames/thumbnails, transcode, and clip via a Railway worker.',
  $prompt$MEDIA (FFMPEG) WORKER (capability = media)

Handles audio/video processing. Uses the shared "Capability worker jobs" lifecycle; this adds the media operations. Create jobs with create_agent_job.

Operations:
- media.probe — return duration, width/height, codecs, frame rate, file size, streams. Cheap; run it first when you need a file's specs.
- media.extract_audio — pull the audio track to wav/mp3/m4a (parameters: {format}).
- media.extract_frames — grab frames at given timestamps or an interval (parameters: {timestamps:[…]} or {interval, count}, {format:"png"|"jpg"}).
- media.create_thumbnail — one representative thumbnail (parameters: {timestamp} or automatic).
- media.transcode — re-encode to another container/codec (parameters: {format, video_codec?, audio_codec?}).
- media.clip — cut a segment (parameters: {start, end} in seconds or HH:MM:SS).

Input manifest role: `source_video` / `source` (required). Reference by file_id.

Example (extract_frames):
create_agent_job({
  operation: "media.extract_frames",
  instructions: "Extract five representative frames for a video preview.",
  input_manifest: [ {file_id:"<video>", role:"source_video", required:true} ],
  parameters: { timestamps:[0,15,30,45,60], format:"png" }
})

Do NOT expose arbitrary ffmpeg arguments — only these operations. When done, show the frames/thumbnail/clip and, if you ran a probe, the media metadata.$prompt$,
  true,
  true,
  'reply'
where not exists (select 1 from public.skills where name = 'Media (ffmpeg) worker' and is_builtin = true);
