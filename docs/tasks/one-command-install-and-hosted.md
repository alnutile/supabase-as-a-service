# Task: One provisioning engine, two front doors (5-minute install + hosted sign-up)

## Context

This app is a team intranet on Supabase. Today, standing up a workspace takes ~8 manual
steps across three dashboards (README "Quick start"): create a Supabase project, `npm
install`, copy `.env`, `supabase link` + `db push`, `secrets set`, `functions deploy`,
deploy the frontend (Railway), and configure the auth Site URL/redirects. That's fine
for a developer and a wall for the actual buyer (see [WHY.md](../../WHY.md) — the
office manager at a 5–50 person services firm).

Two adoption paths close that gap, and they are **the same build with two front
doors**:

- **Path A — the "famous 5-minute install":** `npx create-supanet` provisions
  everything unattended. The WordPress-.org move. Makes the open-source repo instantly
  adoptable and beta-tests the provisioner on real users.
- **Path B — sign-up-and-go:** a hosted control plane runs the *same* provisioner
  server-side behind a signup form. The WordPress-.com move — and probably the actual
  product for the stated buyer.

**Existing machinery this builds on (don't reinvent):**

- `supabase/functions/_shared/management.ts` already talks to the Supabase Management
  API (Forge uses it to deploy edge functions to the live project; `deploy_core`
  redeploys every core function from source bundled into the UI via
  `src/lib/functionSources.ts`). The provisioner is this machinery pointed at
  *bootstrap* instead of maintenance.
- The GitHub Actions (`deploy-migrations.yml`, `deploy-functions.yml`) already encode
  "how to apply migrations / deploy functions non-interactively."
- `usage_events` + `recordUsage()` already meter every AI call — that's the billing
  meter for Path B.
- First-signup-becomes-admin + invite-only already give each project a clean
  single-company security model — which is exactly why Path B should be
  **project-per-tenant**, not multi-tenant (see below).

**The problem:** setup friction filters out the exact buyer the product is for, and
there is no hosted option at all.

**The goal:** one **bootstrap engine** (create project → migrate → deploy functions →
set secrets → configure auth → hand off to in-app onboarding) wrapped twice: a CLI for
Path A, a control plane for Path B. Neither path is "done" at *deployed* — done is the
user sharing their **first artifact link** (the activation metric for both).

---

## Path A — end to end (what the user experiences)

1. **0:00** — README: *"You need two things: a free Supabase account and an OpenRouter
   API key. Then run:"* `npx create-supanet`
2. **0:30** — Installer opens a browser tab to authorize a Supabase access token, then
   asks two questions: workspace name; paste your OpenRouter key.
3. **1:00–4:00** — Unattended: create the Supabase project (Management API), apply all
   migrations, deploy the edge functions, set secrets (`OPENROUTER_API_KEY`, cron
   config), set auth Site URL + redirect allowlist, deploy the frontend (Railway
   template via API, or print a one-click deploy button with the `VITE_*` values
   pre-filled).
4. **4:30** — One line out: *"Your workspace is live at https://acme.up.railway.app —
   sign up now; the first account becomes admin."*
5. **5:00–15:00** — In-app onboarding checklist takes over: invite team → upload 10
   past proposals → write one always-on company prompt → draft something → *"make that
   an artifact"* → share the link. **Done = link shared.**

## Path B — end to end (what the user experiences)

1. **0:00** — Marketing site: *"Start your workspace."* Email, password, workspace
   name. That's the whole form.
2. **0:10** — *"Setting up your workspace…"* A provisioning queue runs the Path A
   engine server-side: one dedicated Supabase project for this customer, migrations,
   functions, per-tenant OpenRouter key provisioned with a spend limit, subdomain
   wired (`acme.supanet.app`).
3. **~2:00** — Email: *"Your workspace is ready."* They sign in (become admin) and land
   in the same onboarding checklist as Path A.
4. **Day 14** — Trial → **flat price per workspace** (order of $29–49/mo), *never per
   seat* — the differentiator made literal — plus AI usage passed through with margin
   (metered from `usage_events`) or bring-your-own OpenRouter key.
5. **Anytime** — the **Eject button**: transfer the Supabase project to the customer's
   own org and hand them the repo. Project-per-tenant means their workspace already
   *is* a standalone deployment, so eject is an ownership transfer, not a migration.
   This is the most defensible sentence in the hosted pitch: *"Leave whenever you want
   and take everything — it was always yours."*

**Why project-per-tenant:** the whole security model (first-user-admin, invite-only,
RLS, workspace-wide sharing) assumes one company per Supabase project. Multi-tenant
would be a rewrite; project-per-tenant makes hosted = automated Path A. Per-project
compute on Supabase paid tiers is roughly single-digit dollars/month per tenant
(**verify current pricing before setting the price point**), which the flat fee covers
with margin.

---

## Build order

1. **Runtime frontend config** *(the one code change both paths need).* `VITE_*` vars
   are baked at build time today (`src/lib/supabase.ts`). Resolve the Supabase URL +
   anon key at runtime — from a `/config.json` (Path A) or by subdomain lookup against
   a tiny control-plane endpoint (Path B) — so **one built frontend serves any
   workspace**. Keep the `VITE_*` build-time path as a fallback so existing deploys
   don't break.
2. **The bootstrap module** *(the whole game).* Extend `_shared/management.ts` (or a
   sibling `bootstrap.ts`, runnable from Node for the CLI) into a pipeline:
   `createProject → waitForHealthy → applyMigrations → deployFunctions → setSecrets →
   configureAuth → verify`. Idempotent and resumable — a failed step re-runs, never
   double-applies. Note the fresh-project storage race (CLAUDE.md gotcha): retry the
   storage section.
3. **Path A wrapper.** `npx create-supanet` (a small published CLI around the
   bootstrap module) + a one-page INSTALL.md + a Railway template button. Ship first:
   it's small once #2 exists, and it beta-tests the provisioner.
4. **In-app onboarding checklist.** Invite → upload → teach (always-on prompt) → draft
   → share a link. Serves both paths; this is where WHY.md's story becomes real.
5. **Path B wrapper.** Control plane: signup form + provisioning queue + wildcard
   subdomain routing (resolves tenant → project URL/anon key for the shared frontend)
   + Stripe + per-tenant OpenRouter key provisioning (their provisioning API supports
   keys with limits) + the eject flow. Ship when Path A's engine has survived real
   users.

## Non-goals

- Multi-tenant (many companies in one Supabase project) — explicitly rejected above.
- Migrating existing hand-deployed workspaces into the hosted control plane.
- Marketplace/billing beyond flat fee + metered AI usage.

## Acceptance

- **Path A:** a person who has never used a terminal beyond pasting one command gets a
  working, signed-in workspace in ≤15 minutes with only a browser, a Supabase account,
  and an OpenRouter key. Measured: time-to-first-shared-artifact.
- **Path B:** signup form → ready email in ≤5 minutes with zero human involvement;
  eject produces a customer-owned project that keeps working untouched.
- Both paths land the user in the same onboarding checklist, and both are provisioned
  by the same bootstrap module — no forked logic.
