# SupaNet control plane

The hosted-offering backend: signup → Stripe → provision a complete per-tenant
SupaNet (dedicated Supabase project + Railway service + OpenRouter key +
`acme.supanet.io`). Spec: [docs/tasks/hosted-control-plane.md](../docs/tasks/hosted-control-plane.md).

Like `workers/`, this is a **separate npm workspace** — not part of the main
Vite app build or its CI.

## Layout

```
engine/            The provisioning pipeline (plain TypeScript, Node-runnable;
                   importable later by control-plane edge functions and by a
                   future `npx create-supanet`)
  pipeline.ts      Resumable step runner (pure; unit-tested)
  steps.ts         createProject → … → verify
  supabaseApi.ts   Management API client (create/migrate/deploy/secrets/auth/pause)
  railway.ts       Per-tenant app service + custom domain  ⚠ verify GraphQL shapes
  cloudflare.ts    acme.supanet.io CNAME upsert
  openrouter.ts    Per-tenant runtime key with spend limit (Provisioning API)
  repoAssets.ts    Loads migrations + function bundles from this repo checkout
  tenant-zero.ts   CLI: run the whole pipeline from a laptop (slice 1)
supabase/          The control plane's OWN Supabase project (slice 2)
  migrations/      tenants, provisioning_jobs, cp_events
```

## Tenant zero (slice 1)

```bash
cd control-plane
npm install
cp .env.example .env    # fill in the credentials (see the file's comments)
npm run tenant-zero -- --slug acme --name "Acme Co" --email you@example.com
```

Progress persists to `tenant-zero.state.json`; a failed run resumes at the
failed step when re-run with the same slug. Prerequisites:

1. A `release` branch exists (`git branch release && git push -u origin release`).
2. A Railway project + environment to hold tenant services (ids in `.env`),
   with the GitHub repo connected to the Railway account.
3. The Cloudflare token is scoped to Zone:DNS:Edit on the supanet.io zone only.

## Tests

```bash
npm test         # pipeline runner unit tests (node:test)
npm run typecheck
```
