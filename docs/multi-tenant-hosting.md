# Multi-tenant hosting — shared-repo fan-out

Host many SupaNet customers off **one core repo** instead of a repo per customer. This doc is the
runbook for the deploy machinery that ships in the repo; the ops steps (creating Supabase projects,
Railway services, and secrets) are manual for now and listed in the onboarding checklist below.

## The model: project-per-tenant, one repo

Each customer install is **three separable pieces**. Only the first two are deployed; the third is data.

| Piece | Per-customer input | Shared from one repo? |
|---|---|---|
| **Frontend** (Vite static build) | `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` (build-time) | ✅ One Railway service per customer, each with its own env |
| **Edge functions + migrations** | Supabase project ref (+ db password) | ✅ `deploy-fleet.yml` fans out to N projects |
| **Customization** | Agents/tools/skills/prompts/tables/collections + **Forge** functions | ✅ Already per-customer — lives in each customer's own Supabase project, not the repo |

Because each customer is its **own Railway service that rebuilds from `main` with its own `VITE_*`**,
the frontend fan-out needs no code: the build-time config in `src/lib/supabase.ts` is fine. N builds
beats one clever runtime-config bundle here.

The only capability that truly needs a per-customer *repo* is the **Features board**
(`/features` → `claude-feature.yml` writes React/TS source into the repo). Shared-tier customers get
it flag-hidden (below) and extend via **data + Forge** instead (Forge deploys new edge functions into
*their* Supabase project, stored in their `forged_functions` table — no repo divergence).

## The one decision that unlocks everything: host owns the Supabase org

If **all customer Supabase projects live under the host's own Supabase org**, then **one** host-held
Supabase access token deploys to *every* customer — no per-customer token (which can't be minted via
CLI/API anyway). This is the assumption the fan-out is built on. Choose it unless a customer
contractually must own their Supabase account (then → **Eject path**, below).

## What ships in the repo

| File | Role |
|---|---|
| `customers.json` | The fleet registry — non-secret names + project refs + Railway service names. Adding a customer = one PR editing this file. |
| `.github/actions/deploy-customer/action.yml` | Composite action: `supabase link` → `db push --include-all` → `functions deploy` for one project. (GitHub Actions has no YAML anchors, so a composite action is how the two matrix jobs stay DRY.) |
| `.github/workflows/deploy-fleet.yml` | `prepare` (split registry) → `canary` (deploy the one canary, fail-fast) → `fleet` (fan out to the rest, `fail-fast:false`). |
| `scripts/seed-shared-tier.sql` | Per-customer onboarding seed that hides the Features board. **Not** a fleet migration. |

The single-target `deploy-migrations.yml` / `deploy-functions.yml` are **left untouched** — they still
deploy the host's own project. The fleet workflow is additive.

## Registry — `customers.json`

Non-secret only (names, refs, Railway service names). Exactly one entry is `"canary": true`:

```json
{
  "customers": [
    { "name": "civicsense", "supabase_ref": "oncnshpcwutkpjanwmbp",
      "railway_service": "civicsense-supanet", "canary": true }
  ]
}
```

Add a customer by appending an object (no `canary` field, or `canary:false`) and opening a PR.

## Secrets (GitHub → Settings → Secrets and variables → Actions)

| Secret | What |
|---|---|
| `SUPABASE_ACCESS_TOKEN` | One host PAT with access to every customer project (works because they're all in the host org). Already used by the single-target workflows. |
| `CUSTOMER_DB_PASSWORDS` | **One JSON secret** mapping ref → db password: `{"oncnshpcwutkpjanwmbp":"…"}`. `db push` connects straight to Postgres, so the token alone is not enough. Parsed per matrix entry via `fromJson(...)`; the composite action re-masks each extracted password with `::add-mask::` (a value pulled out of a JSON secret isn't auto-masked). |

OpenRouter/Resend/etc. keys live in **each customer's Supabase edge-function secrets**, so the deploy
never needs them.

## How the fleet deploy runs

Triggered by a push to `main` touching `supabase/migrations|functions`, `config.toml`, `customers.json`,
or the workflow/action files (or `workflow_dispatch`).

1. **prepare** reads `customers.json` with `jq` and splits it into `canary` and `fleet` arrays.
2. **canary** (`fail-fast: true`) deploys the canary and, if it breaks, stops the whole rollout.
3. **fleet** (`fail-fast: false`, `max-parallel: 4`) runs only when the canary succeeded or was absent,
   and deploys everyone else — one broken customer does not halt the rest. Empty arrays are skipped by
   the job `if:` guards, so a registry with only a canary is safe to run.

## Hide the Features board for shared-tier customers

Run once against the customer's DB at onboarding (see `scripts/seed-shared-tier.sql`):

```sql
insert into public.feature_flags (key, enabled) values ('features', false)
on conflict (key) do update set enabled = excluded.enabled;
```

This is **data, not code** — the flag hides the sidebar + palette entry live. It is **hiding, not
permissions**: the `/features` route stays reachable by URL and the table RLS is unchanged. Don't
wire `claude-feature.yml` for shared-tier either (there's no per-customer repo for it to open PRs
against) — with the board hidden no one reaches the UI to trigger it anyway.

## Frontend — Railway multi-service (manual for now)

- One Railway service per customer, all "Deploy from GitHub repo" → the **core repo**, branch `main`.
- Each service's variables: that customer's `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`.
- A push to `main` rebuilds **every** service, each baking in its own env — "update once → all
  customers update" for the frontend.
- Then add the customer's Railway URL to their **Supabase → Auth → URL Configuration**.

*(Scripting service creation + var setting + domain in one command via Railway's GraphQL API is a
planned follow-up — not required for the first customers.)*

## Per-customer onboarding checklist

- [ ] Create the Supabase project in the **host org**; save ref + db password (→ `CUSTOMER_DB_PASSWORDS`).
- [ ] Set the customer's Supabase edge secrets (`OPENROUTER_API_KEY`, email/Slack as needed).
- [ ] Add `{ name, supabase_ref, railway_service }` to `customers.json` (PR → triggers the fleet deploy).
- [ ] Create the Railway service (repo = core, `VITE_*` vars, domain).
- [ ] Add the Railway URL to Supabase Auth URL Configuration; keep "Allow new users to sign up" **ON**.
- [ ] Run `scripts/seed-shared-tier.sql` against the DB (shared-tier only).
- [ ] First admin signs up (bootstraps the invite-only workspace).
- [ ] Hand over the MCP endpoint (Connect Claude) as a standard deliverable.

## Migration-safety policy (the real ongoing tax — read this)

Once N customers ride one schema, **one careless migration breaks every customer at once**. Every
migration must be **backward-compatible** — expand → migrate → contract:

- **Never** rename or drop a column in the same release that stops using it. Add the new column,
  ship code that writes both / reads new-then-old, backfill, and only remove the old column in a
  *later* release once no deployed frontend references it.
- New columns are nullable or defaulted; new tables are additive.
- Prefer additive enum values over repurposing existing ones.
- Because the frontend and the DB deploy on separate paths, assume a window where **old frontend +
  new schema** and **new frontend + old schema** both exist across the fleet; every migration must
  tolerate both.

This is a process discipline, not something the tooling enforces yet (a CI lint is a possible
follow-up).

## Blast-radius guardrails

- **Canary gate** (built in): the canary deploys and must pass before the fleet fans out.
- **Green CI required**: make `Tests` a required status check on `main` so a red build never reaches
  the fleet.
- **`fail-fast: false`** on the fleet job isolates a single-customer failure.
- **Backward-compatible migrations only** (above).
- **Alerting**: post fleet-job failures to Slack so a partial rollout is visible (follow-up).
- **Rollback path**: tag releases; `functions deploy` + `db push` are re-runnable from a prior tag.

## Eject path (deferred — build when a customer needs it)

When a customer needs real source-level changes:

1. Fork the core repo into a dedicated customer repo (the `upstream` remote is the sync seam).
2. Point that customer's Railway service at the fork instead of the core repo.
3. Remove them from `customers.json` (drops them from the fan-out).
4. Re-enable the Features board flag + wire `claude-feature.yml` in their repo.
5. Optional **managed fork fleet**: a scheduled action opens "sync from core" PRs (`upstream/main` →
   customer fork) so ejected customers still receive core updates.

This is the most speculative, highest-effort piece — don't build it until a customer actually diverges.
