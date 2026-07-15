# Skill: capability-worker-jobs

The shared contract for handing heavy, specialized work to a **capability worker**
instead of running it inside the main app. This is the source-of-truth document;
the same guidance is seeded into the workspace `skills` table (migration
`0078_agent_jobs.sql`) so the assistant loads it automatically.

> Railway is the first deployment target, **not** the architecture. The protocol
> below is Postgres + Storage + Docker + env vars — portable to local Docker
> Compose, Railway, Fly, Render, Kubernetes, or a VPS. Nothing in the worker
> runtime imports a Railway SDK or hard-codes a Railway hostname.

## When to use a worker

Use one when the task: needs a specialized binary/library (OfficeCLI, ffmpeg),
involves binary files, may take more than a few seconds, produces multiple
assets, or should be retryable and isolated.

Do **not** use one for simple text generation, reading a small text file, work an
existing tool already does, or an immediate conversational answer.

## The `agent_jobs` contract

Work is coordinated through the `agent_jobs` table (there is deliberately **no**
`agents` table for this — the skill file is the capability contract, Railway/Docker
is the execution layer). A job carries:

- `capability` (`office` | `media`) and `operation` (e.g. `office.create_docx`).
  The operation prefix must equal the capability. Workers expose a **narrow,
  allow-listed** set of operations — never a freeform "run this command".
- `input_manifest` — references to files/artifacts by `file_id` / `artifact_id` /
  `storage_path` (+ `role`, `required`). **Never** file contents; IDs and
  manifests move through the system, not binaries.
- `parameters` — operation-specific knobs.
- `result_manifest` — what the worker produced (files + artifacts with roles).
- `priority`, `attempts`/`max_attempts`, `idempotency_key`, `worker_id`,
  `lease_expires_at`, `heartbeat_at`, `available_at`, `error`/`error_code`.

### Job statuses

```
queued → claimed → running → completed
                         ├→ failed         (permanent error)
                         ├→ retrying       (transient error; retried after backoff)
                         ├→ cancelled      (cancelled before/while queued)
                         └→ dead_letter    (retries exhausted)
```

### Atomic claiming

Workers must not `select … then update` — two workers could grab the same row.
Claiming goes through the `claim_agent_job(capability, worker_id, lease_seconds)`
RPC, which does an `UPDATE … WHERE id = (SELECT … FOR UPDATE SKIP LOCKED LIMIT 1)`
so exactly one worker wins. It flips the row to `claimed`, sets `worker_id`,
`started_at`, `lease_expires_at`, and increments `attempts`.

### Leases & heartbeats

A claimed job is leased until `lease_expires_at`. The worker extends the lease on
a heartbeat (~lease/3). If a worker dies, `recover_stale_agent_jobs(lease_seconds)`
reclaims jobs whose lease expired — back to `retrying` (or `dead_letter` past
`max_attempts`). Any worker or a `pg_cron` tick can call it.

### Retries & idempotency

Transient failures (storage blips, network, process restart) → `retrying` with
exponential backoff **30s → 2m → 10m**. Permanent failures (unsupported type,
missing input, malformed document, invalid instructions) → `failed`. Past
`max_attempts` → `dead_letter`. Set an `idempotency_key`
(`operation + sorted input ids + normalized instructions + parameters`) so a
repeated identical request doesn't mint duplicate outputs — the DB enforces one
open job per `(owner, key)`.

### Cancellation

`cancel_agent_job(id)` moves a queued/in-flight job to `cancelled`. A worker
checks for cancellation before starting expensive work.

### Tenant isolation

Every input reference is re-verified in the worker to belong to the job's owner
(`ownsResource`); a `storage_path` must sit under the owner's folder. Workers
**never** trust a raw public URL when an ID/path is available.

### Logging

Structured JSON logs only. **Never** log document contents, prompts, tokens,
secrets, or env vars. A per-job `agent_job_events` timeline records
claimed/running/progress/completed/failed/retrying/cancelled/dead_letter.

### Health checks

Each worker serves `GET /health` (liveness + version + capability + active job)
and `GET /ready` (503 until the loop is up).

## Main-AI lifecycle

1. Pick the capability + operation from the request.
2. Build the `input_manifest` (reference files by ID).
3. `create_agent_job(operation, instructions, input_manifest, parameters)` → job id.
4. Tell the user it's working; poll `get_agent_job(id)` until `completed` /
   `failed` / `cancelled` / `dead_letter`.
5. On completed, read the result manifest, present the files/artifacts, and
   continue (make an artifact, run another job, or — only with explicit approval —
   share externally).
6. On failure, explain in plain language and suggest the next action.

The main AI never needs OfficeCLI or ffmpeg internals — see `officecli.md` and
`ffmpeg.md`.

## Local development (Docker Compose)

`infra/docker-compose.yml` runs both workers against your Supabase project using
the same env-var contract as production (`SUPABASE_URL`,
`SUPABASE_SERVICE_ROLE_KEY`, `STORAGE_BUCKET`, `WORKER_CAPABILITY`,
`POLL_INTERVAL_MS`, `JOB_LEASE_SECONDS`, `MAX_ATTEMPTS`, `LOG_LEVEL`). Deployment
provider config lives under `infra/railway/` and is the only Railway-specific part
of the repo.
