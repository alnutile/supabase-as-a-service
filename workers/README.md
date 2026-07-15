# SupaNet capability workers

Standalone Docker services that run heavy libraries against the `agent_jobs` queue,
so the main app never shells out to big binaries. Two workers ship today:

- **office-worker** — Word/Excel/PowerPoint via LibreOffice (`capability = office`)
- **media-worker** — audio/video via ffmpeg (`capability = media`)

They are a **separate npm workspace** (`@supanet/workers`) and are **not** part of
the main Vite app build or its CI. The main app only creates jobs and reads
results (see the `create_agent_job` / `get_agent_job` builtins and
`supabase/functions/_shared/agent_jobs.ts`). The job protocol is documented in
`docs/capability-workers.md` and `skills/capability-workers.md`.

## Layout

```
workers/
  package.json          # npm workspaces root
  shared/               # @supanet/worker-shared — the reusable job loop
    src/                #   contract, env, storage, exec, loop, types
    tests/              #   node:test unit tests for the pure contract
  office-worker/        # LibreOffice worker (Dockerfile + src)
  media-worker/         # ffmpeg worker (Dockerfile + src)
```

Adding a third capability (PDF, OCR, …) is just another `workers/<name>-worker`
that imports `@supanet/worker-shared` and supplies operation handlers — the core
protocol doesn't change.

## Provider neutrality

Railway is the first deployment target, **not** the architecture. The workers talk
only to Postgres (via the Supabase service role) and Storage, and read all config
from env vars — so the same image runs on local Docker Compose, Railway, Fly,
Render, Kubernetes, or a VPS. There are no Railway SDK imports or hard-coded
Railway hostnames anywhere in `src/`. Railway-specific config lives only under
`infra/railway/`.

## Environment contract

| var | required | default | purpose |
| --- | --- | --- | --- |
| `SUPABASE_URL` | ✅ | — | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | ✅ | — | server-side key (never shipped to a browser) |
| `STORAGE_BUCKET` | | `files` | bucket for inputs/outputs |
| `WORKER_CAPABILITY` | | image default | must match the worker if set |
| `WORKER_ID` | | derived | instance id for leases/heartbeats |
| `POLL_INTERVAL_MS` | | `3000` | idle poll interval |
| `JOB_LEASE_SECONDS` | | `120` | lease length; heartbeat is ~lease/3 |
| `MAX_ATTEMPTS` | | `3` | default retry cap (jobs carry their own too) |
| `LOG_LEVEL` | | `info` | debug/info/warn/error/fatal |
| `DATABASE_URL` | | — | optional direct-Postgres escape hatch |

## Develop locally

```bash
cd workers && npm install
npm run build            # typecheck/compile all three packages
npm test -w @supanet/worker-shared

# Run both workers against your Supabase project:
cp ../infra/.env.example ../infra/.env   # fill in the URL + service role key
docker compose -f ../infra/docker-compose.yml --env-file ../infra/.env up --build
# health: curl localhost:8091/health (office), localhost:8092/health (media)
```

## Deploy to Railway

Each worker is its own service. Set the service **Root Directory** to `workers`
and the Dockerfile path to `<worker>/Dockerfile` (see `infra/railway/*.json`), set
the env vars above as service variables, and Railway builds + runs it. The
`.github/workflows/deploy-workers.yml` action builds both images on every change
and deploys when `RAILWAY_TOKEN` is configured.
