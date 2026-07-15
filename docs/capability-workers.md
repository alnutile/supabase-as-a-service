# Capability workers (agent jobs)

Turn excellent open-source libraries into specialized **workers** that do focused
jobs on behalf of the main SupaNet AI. The main AI creates a durable job, the
right worker executes it, and the AI continues when the worker returns its
outputs — so the app never bundles the implementation details of every library and
never shells out to heavy binaries in-process.

First two workers: **office** (Word/Excel/PowerPoint via LibreOffice) and
**media** (audio/video via ffmpeg). The same pattern extends to PDF/OCR/browser/
image/transcription workers without touching the orchestration layer.

## Why no `agents` table

The capability contract lives in **skill files** (`skills/capability-workers.md`,
`officecli.md`, `ffmpeg.md`, also seeded into the `skills` table), the coordination
point is the **`agent_jobs`** table, and the execution layer is a **Docker
worker**. No permanently-registered agent object is needed for v1. A capability
registry can come later if the number of workers grows.

## Runtime flow

```
user request
  → main AI loads the relevant skill
  → create_agent_job → agent_jobs row (queued)
  → a worker atomically claims it (claim_agent_job, FOR UPDATE SKIP LOCKED)
  → worker downloads inputs from Storage (ownership re-verified)
  → worker runs OfficeCLI / ffmpeg in a temp dir
  → worker uploads outputs + writes result_manifest
  → worker marks the job completed (lease/heartbeat guards a crash)
  → main AI reads the manifest and delivers the files/artifacts
```

IDs and manifests move through the system — never large binaries through the
prompt.

## Pieces in this repo

| Piece | Where |
| --- | --- |
| `agent_jobs` + `agent_job_events` tables, `claim_agent_job` / `recover_stale_agent_jobs` RPCs, events, seeded builtins + skills | `supabase/migrations/0080_agent_jobs.sql` |
| Pure job logic (validation, manifest, idempotency, backoff, failure policy) | `supabase/functions/_shared/agent_jobs.ts` (unit-tested in `tests/agent_jobs_test.ts`) |
| Main-AI builtins `create_agent_job` / `get_agent_job` / `list_agent_jobs` / `cancel_agent_job` | `supabase/functions/_shared/builtins.ts` |
| Reusable worker runtime (claim loop, storage, lease/heartbeat, health, events) | `workers/shared/` |
| The two workers | `workers/office-worker/`, `workers/media-worker/` |
| Local dev + isolated Railway config | `infra/docker-compose.yml`, `infra/railway/*.json` |
| Build/deploy CI | `.github/workflows/deploy-workers.yml` |

## Job lifecycle

Statuses: `queued → claimed → running → completed`, with `failed` (permanent),
`retrying` (transient, backoff **30s → 2m → 10m**), `cancelled`, and `dead_letter`
(retries exhausted). Leases (`lease_expires_at` + heartbeats) let a crashed
worker's job be recovered. An `idempotency_key` (operation + sorted input ids +
normalized instructions + parameters) prevents duplicate outputs; the DB enforces
one open job per `(owner, key)`.

## Security

- Workers expose **narrow, allow-listed operations** — never a freeform "run this
  command"; the operation prefix must match the capability.
- Every input is re-verified to belong to the job owner; a `storage_path` must sit
  under the owner's folder. Raw user-supplied URLs are never trusted when an ID is
  available.
- Supabase Storage is authoritative for files; the worker filesystem is temporary
  and wiped after each job.
- Secrets come from the worker environment, never from job instructions; logs are
  structured JSON and never contain document contents, prompts, tokens, or env.
- The service-role key stays server-side. RLS: a requester sees their own jobs
  (admins see all); workers write via the service role.

## Provider neutrality (Railway is a target, not the architecture)

The worker runtime depends only on Postgres + Storage + env vars. The same image
runs on local Docker Compose, Railway, Fly, Render, Kubernetes, or a VPS. No
Railway SDK or hostname is imported in `workers/src`; the only Railway-specific
files are under `infra/railway/`. Supabase Storage — not a Railway volume — is the
authoritative store for customer files. Moving providers means changing deployment
config, not rewriting SupaNet.

## Try it

Upload an old proposal + a rate card in Files, then ask SupaNet to draft the next
proposal in the same structure: the office worker creates the DOCX + a rendered
preview + a validation report, and the AI returns them. Or "extract five frames
from this video" → the media worker returns the frames + a probe report.
