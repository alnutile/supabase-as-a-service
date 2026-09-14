---
name: release-to-tenants
description: Cut a SupaNet release and roll it out to every tenant — open the `main → release` PR, merge it, watch the `Release to tenants` fan-out apply migrations + deploy edge functions to each tenant Supabase project, and verify nothing is left pending. Use whenever someone says "do a release", "cut a release", "ship to the tenants", "push this to all tenants/customers", "release main", or asks why a tenant is missing a table/function that exists on origin. Also covers canary (one-tenant) rollouts, dry runs, and re-running a failed tenant.
---

# Release to tenants

SupaNet runs as one **origin** project plus many **tenant** apps. Each tenant is its own
Supabase project + Railway frontend, all under the maintainer's Supabase org. A release moves
everything on `main` out to the whole fleet, and it is **one merge**: `main → release`.

That merge triggers two things:

| What | How | Where it's defined |
| --- | --- | --- |
| Frontend | Each tenant's Railway service rebuilds from the `release` branch | Railway (per-tenant service, created by `control-plane/`) |
| DB migrations + edge functions | `.github/workflows/release-tenants.yml` fans out to every live tenant | this repo |

The fan-out reads the tenant list from the control plane's `tenants` table
(`status in ('active','past_due')`, via `scripts/list-tenants.ts`). For each tenant it runs
`scripts/apply-migrations.ts <ref>` (pending migrations over the Management API SQL endpoint,
each one in a transaction with its `schema_migrations` row, then `setup_automation_cron`) and
`supabase functions deploy --project-ref <ref>`. One org-owner PAT (`SUPABASE_ACCESS_TOKEN`)
reaches every tenant, so no per-tenant secret exists and tenants don't have to do anything.
The matrix is `fail-fast: false`, `max-parallel: 4`, and a newer run never cancels one already
in flight.

You don't need any Supabase credentials locally. Everything below runs through `gh`.

## Hard rules

- **Never commit to `release` directly.** It only ever receives `main` via the release PR.
  A commit authored on `release` makes the next release PR conflict. (That happened once, in
  PR #258.)
- **Merge with a merge commit (`--merge`).** Don't squash or rebase: both rewrite history so
  it no longer matches `main`.
- **Never force-push `release`**, and never cancel a running `Release to tenants` job. A
  half-applied fleet is worse than waiting for the run to finish.
- **Origin goes first.** Don't cut a release until `main`'s own deploy workflows have passed
  for the commit you're shipping. Origin is the canary for every migration.
- **Don't edit a migration that has already shipped to tenants.** Fix it with a new
  migration. The one exception: a migration that *failed* never recorded as applied, so you
  can fix that file in place and re-run it.
- Anything addressed to someone other than the maintainer (PR body, Slack note) is written
  **as the AI**, as a technical report. Don't write in the maintainer's first person.

## 1. Preflight

```bash
git fetch origin --quiet
git log --oneline origin/release..origin/main            # what this release ships
git diff --stat origin/release origin/main               # the same, as files
gh run list --branch main --limit 10                     # origin deploys for the head commit
gh run list --workflow release-tenants.yml --limit 3     # nothing in flight?
cat infra/tenants.json                                   # refs should be [] (all tenants)
```

Stop and report back if any of these is true:

- **Nothing to ship.** `origin/release..origin/main` is empty and the diff is empty.
- **Origin isn't green.** Every workflow that ran for `main`'s head commit has to be
  `success`: `Tests`, and `Apply database migrations` if the release touches
  `supabase/migrations/**`, and `Deploy edge functions` if it touches
  `supabase/functions/**`. Wait for runs still in progress.
- **A fan-out is already running.** Wait for it to finish.
- **`infra/tenants.json` lists refs you didn't mean to pin.** A non-empty list overrides the
  control plane, so the release would reach only those tenants.

`git log origin/main..origin/release` always shows a few commits. Those are the merge commits
from earlier releases, and they're expected. What matters is that the content matches:
`git diff origin/release origin/main` should show only the changes this release ships. If it
also shows changes that exist **only on `release`**, someone committed to `release` directly.
Fix that first. Merge `release` into `main` and resolve every conflict in `main`'s favor
(`main` is the superset), then continue.

Check the migrations too:

```bash
git diff --name-only origin/release origin/main -- supabase/migrations/
npm test -- src/lib/migrations.test.ts                   # unique, gap-free prefixes
```

Read each new migration. Anything that isn't idempotent or backward-compatible (drops,
renames, `not null` without a default, a changed function return type without
`drop function if exists`) will run against every tenant's live data. Point it out in the PR
body. If it looks unsafe, ask before shipping.

## 2. Cut the release PR

Title: `Release: <headline change>`. For the body, follow the earlier release PRs:
`gh pr list --state merged --base release --limit 5`, then `gh pr view <n>`.

```bash
gh pr create --base release --head main \
  --title "Release: <headline>" \
  --body-file <scratch>/release-body.md
```

Body outline:

1. One line: *"Cuts a release of `main` so the tenant fleet picks up the changes since the
   last cut."*
2. **Headline.** What changed and why, with the PR numbers
   (`git log --oneline origin/release..origin/main`).
3. **Migrations in this cut.** One line per new file: what it does, and whether it's
   schema-less, idempotent, or needs data backfill.
4. **What the fan-out does.** Migrations + functions + cron on every `active`/`past_due`
   tenant, `fail-fast: false`.
5. **Origin already verified.** The `main` runs that passed, with their conclusions.
6. The attribution footer your harness requires.

The release PR runs `Tests`. Wait for it:

```bash
gh pr checks <n> --watch
```

## 3. Merge

```bash
gh pr merge <n> --merge --subject "Release: <headline> (#<n>)"
```

`Release to tenants` only triggers when the push touches `supabase/migrations/**`,
`supabase/functions/**`, `supabase/config.toml`, `infra/tenants.json`, `scripts/*` or the
workflow file itself. A frontend-only release runs no fan-out. Railway rebuilds the tenant
frontends either way, so a missing run isn't a failure.

## 4. Watch the fan-out

```bash
gh run list --workflow release-tenants.yml --limit 1           # grab the run id
gh run watch <run-id> --exit-status
gh run view <run-id>                                           # one job per tenant ref
gh run view <run-id> --log | grep -E '\] (applied|applying|done|ERROR|cron|[0-9]+ applied)'
```

A healthy tenant logs `[<ref>] N applied · M pending`, then `applying …` / `applied …` for
each migration, `automation cron scheduled`, and `done — M migration(s) applied`, followed by
the functions deploy. If the `list` job logs `0 live tenant(s)`, the control plane has no
live tenants and the rollout job skips.

## 5. Verify

Run a dry-run fan-out afterwards. It lists what's still pending on every tenant and applies
nothing, so you get a fleet-wide check with no local credentials:

```bash
gh workflow run release-tenants.yml --ref release -f dry_run=true
gh run list --workflow release-tenants.yml --limit 1           # wait for it to appear
gh run watch <run-id> --exit-status
gh run view <run-id> --log | grep -E '\] [0-9]+ applied'       # expect "· 0 pending" everywhere
```

Also confirm that `git diff origin/release origin/main` is now empty, unless `main` moved
while you worked.

## If a tenant fails

Every tenant is its own matrix job, so one failure leaves the others untouched. For the
failed job:

1. Read the error. `gh run view <run-id> --log-failed`.
2. Common causes:
   - **A migration errored.** Its transaction rolled back and nothing was recorded. Fix the
     SQL (in place is fine, since it never applied anywhere it failed), land the fix on
     `main`, and cut a follow-up release. If the same migration applied cleanly on origin,
     the tenant probably drifted. Report that before you patch around it.
   - **`SQLSTATE 42P13 cannot change return type`.** The migration needs a
     `drop function if exists …` before the `create or replace`.
   - **Tenant history is empty and it re-applies from 0001.** That tenant wasn't initialised
     with `db push`. Report it; don't hand-edit `schema_migrations`.
   - **Functions deploy failed while migrations passed.** It's usually transient. Re-run it.
3. Re-run just the failed tenants. Both scripts are idempotent, so already-applied
   migrations are skipped:
   ```bash
   gh run rerun <run-id> --failed
   ```

## Canary rollout (one tenant first)

For a risky migration, pin the rollout to one tenant first:

1. On `main`, set `infra/tenants.json` → `"refs": ["<tenant-ref>"]`. Get the ref from the
   control plane or a previous run's matrix. Release as normal: only that tenant updates.
2. Verify that tenant (step 5, or check the app itself).
3. On `main`, set `"refs": []` and release again. The fan-out now covers every live tenant.
   The canary is skipped because it has nothing pending.

Never leave `refs` pinned. While a ref is listed, new tenants never get updates.

## Dry run before releasing

To see what *would* apply to each tenant without merging anything:

```bash
gh workflow run release-tenants.yml --ref main -f dry_run=true
```

This runs the workflow from `main`'s migrations against the live tenants and applies nothing.
Use it to check a big migration batch before you cut the release.

## Report back

When the rollout finishes, tell the maintainer:

- the release PR link and merge commit
- the migrations shipped
- the fan-out run link, with each tenant's result (and any failed tenant, its error, and
  what you did about it)
- the dry-run verification result

Keep it short and factual.
