---
name: vibe-coding
description: >-
  Use when someone wants to "vibe code" a new application from a plain-English idea
  and get it deployed with auth, a database, and CI/CD already wired up — e.g. "I
  want to vibe code a CRM", "spin up a new app for X", "take this idea from zero to
  deployed". Encodes this workspace's house stack (React + Vite + TypeScript +
  Tailwind on Supabase, an OpenRouter edge function, RLS + anon-key + Vault security,
  and GitHub Actions that keep Supabase and Railway in sync from `main`) and the
  provisioning playbook that turns an idea into a live URL with as few human clicks
  as the GitHub / Supabase / Railway APIs allow. Not for editing an already-scaffolded
  app — this is the zero-to-deployed path.
---

# Vibe coding a new application

The house way to go from "I want an app that does X" to a live, signed-in URL —
without the person babysitting three dashboards. This repo (**Intranet In A Box**)
is the **reference stack**; a new vibe-coded app reproduces its shape so every app
we ship shares one security model, one deploy pipeline, and one set of conventions.

## The one principle

**Auth, data isolation, secret hygiene, and CI/CD are defaults, never bolt-ons.**
The very first commit of a new app already has: Supabase Auth, row-level security on
every table, the anon key as the *only* thing in the browser, real secrets in
Supabase Vault (never in the repo or the bundle), and the three GitHub Actions that
redeploy on merge to `main`. If any of those is missing at the end, the job isn't
done — you've built a prototype, not an app on this stack.

Read `references/stack-and-conventions.md` for the exact defaults and the starter
file manifest. Read `references/provisioning.md` for the precise API / MCP / CLI
calls for each provider and what still needs a human click today.

## When this fires

The user says something like "vibe code a `<thing>`", "build me a new app for
`<thing>`", "I have an idea — get it deployed", or "spin up `<thing>` from scratch."
If they instead want to change an app that already exists, this skill doesn't apply —
just work in that repo.

## The flow (idea → deployed)

Work the phases in order. Confirm the idea and the names once up front, then run the
provisioning as unattended as the tooling allows — don't stop to ask about anything
you can pick a sensible default for.

### 0. Pin the idea (one short exchange, then go)

Get only what you can't infer:

- **What it does**, in one or two sentences (the elevator version is enough to start).
- **A name / slug** (e.g. `acme-crm`) — used for the repo, the Supabase project, and
  the Railway service. Offer one if they don't care.
- **The data model, roughly** — the handful of "things" the app tracks (contacts,
  invoices, tickets…). You'll turn these into RLS-protected tables. A rough list is
  fine; the schema evolves.
- **Who can sign in** — invite-only (default, first user is admin) or open signup.

Everything else has a house default. Don't turn this into a requirements interview.

### 1. Scaffold the code

Stand up the reference stack in a working tree. Reproduce the shape documented in
`references/stack-and-conventions.md`:

- Vite + React + TypeScript + Tailwind frontend; `src/lib/supabase.ts` builds the
  typed client from `VITE_SUPABASE_URL` + `VITE_SUPABASE_ANON_KEY` (build-time).
- Supabase Auth context + a `ProtectedRoute` gate; a login page; the app behind it.
- `supabase/migrations/0001_init.sql`: the idea's tables, **each with RLS enabled and
  owner-scoped policies from line one**, plus the `profiles` table + `handle_new_user`
  trigger + invite-only guard (copy the pattern from this repo's `0001_init.sql`).
- If the app needs AI, the `chat` edge function pattern (OpenRouter key server-side
  only) — otherwise skip it; not every app needs a model.
- The three workflows under `.github/workflows/` (`test.yml`, `deploy-functions.yml`,
  `deploy-migrations.yml`) and `railway.json`, copied and de-parameterized (the
  project ref becomes a repo variable, so nothing is hardcoded to this project).
- `npm run build` (`tsc -b && vite build`) must pass before anything is pushed.

The fastest correct path is usually to **use this repo as the template** and strip it
down to the idea, rather than hand-assembling from an empty folder — you inherit the
security model and CI for free. Trim features the idea doesn't need; keep the spine.

### 2. Provision the backend (Supabase — fully automatable via MCP)

This is the part that needs zero clicks. Using the Supabase MCP tools
(`mcp__Supabase__*`), in order:

1. `list_organizations` → pick the org; `get_cost` + `confirm_cost` for a new project.
2. `create_project` with the slug → wait until it's healthy.
3. `apply_migration` for each file in `supabase/migrations/` in order.
4. `deploy_edge_function` for each function the app ships (e.g. `chat`).
5. `get_project_url` + `get_publishable_keys` → capture the URL and anon key for the
   frontend build variables.
6. `get_advisors` (security) → fix anything it flags **before** calling it done. A new
   table without RLS shows up here; that's your safety net.

The couple of things the Supabase MCP does *not* cover today — edge-function secrets
(`OPENROUTER_API_KEY`, cron config) and the Auth Site URL / redirect allowlist — are
done via the Management API or `supabase` CLI. Exact calls are in
`references/provisioning.md`. Do them; they're what make auth redirects and AI work.

### 3. Create the GitHub repo and push (mostly automatable)

Using the GitHub MCP tools (`mcp__github__*`):

1. `create_repository` (private by default) under the account the user names.
2. `push_files` — the whole scaffold in one commit on `main`.
3. Set the repo **variable** `SUPABASE_PROJECT_REF` and the repo **secrets**
   `SUPABASE_ACCESS_TOKEN` + `SUPABASE_DB_PASSWORD` so the deploy workflows work.

⚠️ **The one honest gap:** the GitHub MCP tools here can create the repo and push
files but do **not** set Actions secrets/variables. That needs either the GitHub REST
secrets API (encrypt the value against the repo's public key) or a few clicks in
**Settings → Secrets and variables → Actions**. `references/provisioning.md` gives the
REST path; if it's not wired up, hand the user the exact 3-item checklist to paste and
stop pretending it was fully hands-off. Everything else in this phase is automated.

### 4. Deploy the frontend (Railway)

Railway serves the Vite build as a static site (`railway.json` + the `start` script
are already in the scaffold). Two paths, least-clicks first:

- **Railway API** (if a `RAILWAY_TOKEN` is available): create project → link the GitHub
  repo → set the `VITE_SUPABASE_URL` + `VITE_SUPABASE_ANON_KEY` service variables →
  trigger a deploy. Fully unattended. Commands in `references/provisioning.md`.
- **One-click button** (no token): hand the user a "Deploy on Railway" URL with the
  `VITE_*` values pre-filled — one authorize + one click. This is the realistic
  default until a Railway token is set up.

`VITE_*` are **build-time** — they must be set *before* Railway's first build or the
bundle ships without them. If they were added after a failed first build, redeploy.

### 5. Close the loop on auth (the click everyone forgets)

Add the live Railway URL to Supabase **Auth → URL Configuration** (Site URL + redirect
allowlist) so magic links and email confirmations land back on the app instead of
`localhost`. Automatable via the Management API auth-config PATCH (see references). If
you skip this, signup "works" but the confirmation link is broken — always do it.

### 6. Verify it's actually live

Not "deployed" — *working*. Load the Railway URL, sign up (first user becomes admin),
confirm the protected app renders and one create/read round-trips through RLS. Run
`get_advisors` one last time. Report the live URL, the repo URL, the Supabase project
ref, and anything that still needs a human click, as a short checklist.

## What's automated vs. what still needs a human (be honest)

| Step | Today's reality |
| --- | --- |
| Supabase project, migrations, functions, anon key | **Automated** (Supabase MCP) |
| Supabase edge secrets + auth URL config | Automated via Management API / CLI |
| GitHub repo + initial push | **Automated** (GitHub MCP) |
| GitHub Actions secrets/variables | **Needs REST-secrets API or a few clicks** |
| Railway deploy | Automated *with* a `RAILWAY_TOKEN`; else one-click button |
| First signup (becomes admin) | The human does this — it's the activation moment |

Never claim "zero clicks" when a click remains. State exactly what's left. The North
Star (see `docs/tasks/one-command-install-and-hosted.md`) is a single bootstrap engine
that erases the remaining clicks; this skill is that vision run by hand until it exists.

## Guardrails

- **Never** put a service-role key, a PAT, or an OpenRouter key in the repo, the
  frontend bundle, or a commit. Anon key in the browser only; everything else in Vault
  or as an edge/CI secret. If you catch yourself writing a real secret into a file
  that gets pushed, stop and move it.
- **Never** ship a table without RLS. `get_advisors` is the check; a finding there is a
  blocker, not a warning.
- Keep migration filenames uniquely and contiguously numbered — `db push` derives the
  version from the prefix and rejects collisions.
- Don't over-ask in phase 0. The stack has opinions; use them and keep moving.
