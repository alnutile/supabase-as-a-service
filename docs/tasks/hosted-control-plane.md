# Task: Hosted SupaNet — the supanet.io control plane

## Context

[one-command-install-and-hosted.md](./one-command-install-and-hosted.md) specced two
front doors on one provisioning engine. This doc is **Path B decided and concretized**:
the WordPress-.com move — a customer signs up at supanet.io and gets a running SupaNet
workspace without ever touching Supabase, OpenRouter, or Railway. We host everything;
they just sign in.

**Decisions made (2026-07):**

- **Monorepo:** the control plane lives in this repo as `control-plane/`, a separate
  npm workspace exactly like `workers/` — not part of the main Vite build or its CI.
- **Per-tenant infrastructure, all owned by us:**
  - One dedicated **Supabase project per customer**, created in our org (Sundance
    Solutions) via the Management API. Customers never see the Supabase dashboard.
  - One dedicated **Railway service per customer**, deployed from this repo's
    **`release` branch** (see below). Because each tenant gets its own build, the
    per-tenant `VITE_SUPABASE_URL`/`VITE_SUPABASE_ANON_KEY` are baked in as ordinary
    build-time env vars — **zero changes to the app frontend**. (The runtime-config
    work in the old spec's build order #1 was only needed for a shared-frontend
    model; it is not needed here.)
  - One **per-tenant OpenRouter API key** minted through OpenRouter's Provisioning
    API with a spend limit — customers never bring a key. This *is* the "proxy":
    the key limit caps burn, and the key's usage endpoint is our AI billing meter.
    A literal proxy service is a later optimization, not v1.
  - Tenant subdomains on **`*.supanet.io`** (Cloudflare): `acme.supanet.io` CNAMEs
    to that tenant's Railway service domain via the Cloudflare API.
- **Paid from day one — no free tier.** Signup goes straight to Stripe Checkout
  (test mode until launch); provisioning starts only after `checkout.session.completed`.
  Cancel anytime via the Stripe customer portal: the workspace pauses at period end
  and is deleted after a 30-day grace window (with an export/eject notice). Marketing
  carries the conversion load (videos, docs, the open-source path as the free tier).
- **Price: $49/mo flat per workspace, never per seat**, including a monthly AI-usage
  allowance (order of $10); overage metered with margin. Cost floor per tenant is
  roughly Supabase micro compute (~$10/mo) + Railway service (~$5/mo) + AI usage, so
  ~$30+/mo gross margin before AI margin. **Verify current Supabase/Railway pricing
  before launch.**

## The `release` branch (fleet versioning)

Create a long-lived `release` branch. Every tenant Railway service tracks it.

- Development continues on `main` exactly as today (trunk-based, auto-deploys our own
  instance + docs).
- Shipping to customers = fast-forward `release` to a vetted point of `main`. Railway
  auto-redeploys every tenant service on the push — fleet upgrade is one merge.
- A broken release is rolled back by force-updating `release` to the prior point
  (Railway redeploys again). DB migrations must therefore stay
  backward-compatible one release back (already the norm here — additive migrations).
- Tenant Supabase migrations are applied by the provisioner/upgrader from the
  `release` checkout, so app code and schema move together.

## Architecture

```
control-plane/
  package.json          # own workspace, own CI job (like workers/)
  engine/               # THE provisioning engine (plain TypeScript, Node-runnable)
    steps/              #   createProject, applyMigrations, deployFunctions,
                        #   setSecrets, configureAuth, mintOpenRouterKey,
                        #   createRailwayService, wireDns, verify
  supabase/             # the control plane's OWN Supabase project
    migrations/         #   tenants, provisioning_jobs, subscriptions, cp_events
    functions/
      signup/           #   public: email+workspace name → tenant row (pending_payment)
                        #   + Stripe Checkout session URL
      stripe-webhook/   #   checkout completed → enqueue provisioning job;
                        #   subscription canceled/past_due → pause lifecycle
      provision-tick/   #   pg_cron-ticked (cron-secret gated, like scheduler):
                        #   claims a job, runs engine steps, writes progress
      lifecycle-tick/   #   pause at period end, delete after grace, dunning emails
      status/           #   public: polling endpoint for the "setting up…" page
  src/                  # small Vite app: signup form, provisioning status page,
                        #   internal admin dashboard (tenant list, retry, pause)
```

**The engine is the whole game** (unchanged from the old spec): a pipeline of
idempotent, resumable steps — `createProject → waitForHealthy → applyMigrations →
deployFunctions → setSecrets → configureAuth → mintOpenRouterKey →
createRailwayService → wireDns → verify`. Each step records completion on the job row
(a `progress` jsonb checklist, same pattern as `security_scans.progress`), so a failed
run re-enters at the failed step and never double-applies. Known gotcha to honor: the
fresh-project storage race (CLAUDE.md) — retry the storage-touching migration section.

It reuses/extends existing machinery, moved where Node can import it:
`supabase/functions/_shared/management.ts` already deploys functions via the
Management API; the GitHub workflows already encode non-interactive migrate/deploy.
Keep the engine importable by a future `npx create-supanet` (Path A) — same steps
minus org/Railway/DNS, so the two paths never fork.

**External APIs the control plane drives** (secrets in the control-plane project's
edge-function secrets, never client-side): Supabase Management API (org PAT),
Railway GraphQL API (service create/pause/delete, env vars, custom domain),
Cloudflare API (DNS records on supanet.io), OpenRouter Provisioning API (per-tenant
keys + limits), Stripe (slice 5), and an email provider (Postmark/Resend, same
HTTP-provider pattern as the app's `send_email`).

**Tenant state machine:** `pending_payment → provisioning → active | past_due |
canceled → paused → deleted` (+ `failed` for provisioning errors, retryable from
admin). Stripe webhooks drive the transitions; `lifecycle-tick` enforces them:
canceled or unpaid past grace → pause the Railway service AND the Supabase project
(both APIs support pause — a paused tenant costs ~nothing), +30 days → delete with
a final "export your data / eject" notice. Nothing provisions before money clears,
so there is no free-tier abuse surface; still cap each tenant's OpenRouter key
(limit ≈ allowance + margin buffer, raised as their plan grows) so a runaway agent
can't outspend its subscription.

## Signup UX (the product promise)

1. supanet.io → "Start your workspace": email, password, workspace name. Whole form.
2. Straight into Stripe Checkout ($49/mo; test mode until launch). Payment confirmed
   → "Setting up your workspace…" page polls `status` (progress checklist ticking
   live — same feel as the security scan UI).
3. ≤5 min later: "Your workspace is ready" email + redirect to
   `https://acme.supanet.io` — first sign-in becomes admin (existing behavior),
   landing in the in-app onboarding checklist (shared with Path A; still to build).
4. Anytime: cancel via the Stripe customer portal (pauses at period end), or
   **eject** — we transfer the Supabase project to their org and hand them the
   repo; per-tenant everything means their workspace already *is* a standalone
   deployment.

## Build order

1. **Engine + tenant zero (manual).** Write `control-plane/engine` and provision one
   real tenant by running it from a laptop against a test signup. Proves the
   Management/Railway/Cloudflare/OpenRouter API choreography before any UI exists.
   Create the `release` branch as part of this.
2. **Control plane backend.** Its Supabase project: `tenants` + `provisioning_jobs`
   schema, `provision-tick` running the engine server-side, internal admin page.
   Provisioning now survives laptop-closed.
3. **Signup + Stripe (test mode).** Signup form → Checkout session → webhook
   (`checkout.session.completed` → enqueue provisioning) → live status page →
   ready email. This is launchable-in-private-beta with test cards.
4. **Subscription lifecycle.** `lifecycle-tick` + Stripe webhooks: cancel/past_due
   → pause, grace expiry → delete, dunning emails, customer portal link in the
   tenant admin's email. Metered AI overage from per-tenant OpenRouter key usage,
   billed with margin (usage records on the subscription).
5. **Hardening + eject.** Quotas, monitoring/alerting on failed provisions, flip
   Stripe to live mode, the eject flow (project ownership transfer + goodbye email
   with repo link).

## Non-goals (v1)

- Multi-tenant (many companies per Supabase project) — still explicitly rejected.
- A literal OpenRouter proxy service — provisioned keys with limits do the job.
- Custom domains (`ai.acme.com`), SSO/SAML, per-seat anything.
- Migrating existing self-hosted workspaces into the control plane.
- Path A (`npx create-supanet`) — later, but the engine must stay importable for it.

## Acceptance

- Signup → paid Checkout (test card) → "ready" email in ≤5 minutes with zero human
  involvement; the tenant workspace at `acme.supanet.io` works end to end (sign in
  → chat → share an artifact link).
- A failed provision is visible in admin and resumable from the failed step.
- Merging `main → release` upgrades every tenant with no per-tenant work.
- A canceled or unpaid subscription pauses its workspace automatically; paying
  again (or fixing the card) unpauses it.
- Eject produces a customer-owned Supabase project + repo handoff that keeps
  working untouched.
