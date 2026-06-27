# Handoff: sync Supabase migration history so `supabase db push` works in CI

**Audience:** an AI/engineer working at a terminal with the Supabase CLI and the
project's credentials.
**Goal:** make the remote database's migration *history bookkeeping* match this
repo's migration files, so the normal `supabase db push` GitHub Action
(`.github/workflows/deploy-migrations.yml`) applies new migrations automatically
from then on — like a normal Supabase project.
**Risk level:** low. You only edit the bookkeeping table
`supabase_migrations.schema_migrations`. **No application schema changes, no data
migration.** Every object the migrations create already exists in the database.

---

## 1. Background — why this is needed

This project's migrations were historically applied through the **Supabase
Management API** (the in-app "Forge" feature and the MCP `apply_migration` action),
**not** through the CLI's `supabase db push`. As a result:

- The **remote** history (`supabase_migrations.schema_migrations`) is stamped with
  **14-digit timestamp versions** (e.g. `20260627203631`) and Management-API names.
- The **repo** names migrations **sequentially**: `0001_init.sql` … `0037_vault_secrets.sql`.

`supabase db push` matches migrations **by version string**. Because every remote
version (`20260…`) is absent from the local files (`0001…`), push aborts with:

```
Remote migration versions not found in local migrations directory.
```

The two histories are **not 1:1** — several repo files bundle multiple
Management-API migrations (the remote has ~5 more entries than the repo, e.g.
`lock_down_log_triggers`, `schedule_cron_tick`, `ingest_cron_tick`,
`user_tables_hardening`, `authoring_builtins`). So **renaming repo files to
timestamps is NOT the move.** Instead, rewrite the bookkeeping so the remote
history equals the repo's sequential versions.

> ⚠️ The fix is **two** steps, not one. The CLI's own error message only suggests
> `migration repair --status reverted …` (clearing the timestamp rows). If you stop
> there, the next `db push` will try to **re-run all 37 local migrations** against a
> database that already has every object → `relation already exists` errors. You
> must **also** mark the local versions as **applied** so push skips them.

---

## 2. Current state (snapshot taken 2026-06-27)

- **Project ref:** `pcyvmpjrszgatwvmyxbg`
- **Local files:** 37, contiguous `0001`–`0037` (`supabase/migrations/*.sql`).
- **Remote history:** 42 timestamp rows (verify live — an automated process has been
  adding rows, so re-check rather than trusting this list blindly).

**Local versions (the 37 to mark _applied_):**

```
0001 0002 0003 0004 0005 0006 0007 0008 0009 0010 0011 0012 0013 0014 0015 0016
0017 0018 0019 0020 0021 0022 0023 0024 0025 0026 0027 0028 0029 0030 0031 0032
0033 0034 0035 0036 0037
```

**Remote timestamp versions at snapshot time (the ones to mark _reverted_):**

```
20260609123129 20260609123155 20260609123249 20260609150304 20260609161747
20260609162658 20260609164624 20260610005430 20260610011135 20260610011700
20260610101215 20260610215215 20260610231232 20260610231340 20260610231751
20260611005829 20260611010013 20260611100515 20260611104338 20260611105331
20260611120605 20260613163134 20260613195733 20260620012857 20260620015522
20260620021045 20260620194218 20260620200348 20260620203031 20260620213714
20260620213729 20260622103438 20260622103804 20260622104423 20260626122044
20260626205049 20260627151502 20260627151511 20260627151515 20260627203631
20260627213032 20260627214228
```

> Don't trust this list blindly — **re-derive it live** (Step 4). Anything matching
> `^[0-9]{14}$` in the remote history is a timestamp row to revert.

---

## 3. Prerequisites

```bash
supabase --version            # install via https://supabase.com/docs/guides/cli if missing
export SUPABASE_ACCESS_TOKEN=… # Supabase PAT (Dashboard → Account → Access Tokens)
export SUPABASE_DB_PASSWORD=…  # Project DB password (Dashboard → Project Settings → Database)

# From the repo root:
supabase link --project-ref pcyvmpjrszgatwvmyxbg
```

`supabase link` picks up both env vars and shouldn't prompt. Confirm the link:

```bash
supabase migration list        # shows LOCAL | REMOTE | TIME columns
```

You should see local `0001…0037` on the left and the mismatched `20260…` timestamps
on the right. That mismatch is exactly what we're fixing.

---

## 4. Reconciliation

### Step 0 — Back up the bookkeeping table (do this first)

```bash
psql "$(supabase db url 2>/dev/null || true)" -c \
  "create table if not exists supabase_migrations.schema_migrations_backup_20260627 as
   table supabase_migrations.schema_migrations;"
```

If `supabase db url` isn't available in your CLI version, build the connection string
from the Dashboard (Project Settings → Database → Connection string → URI) and run the
same `create table … as table …` statement. This lets you restore the exact prior
history if anything looks wrong.

### Step 1 — Mark every local migration as APPLIED

```bash
supabase migration repair --status applied \
  0001 0002 0003 0004 0005 0006 0007 0008 0009 0010 0011 0012 0013 0014 0015 0016 \
  0017 0018 0019 0020 0021 0022 0023 0024 0025 0026 0027 0028 0029 0030 0031 0032 \
  0033 0034 0035 0036 0037
```

This inserts rows `0001…0037` into `schema_migrations` **without running the SQL**
(the schema already exists). Order doesn't matter; do this before any `db push`.

### Step 2 — Mark every remote-only timestamp version as REVERTED

Re-derive the list live (safer than the snapshot), then revert it:

```bash
# Print every 14-digit timestamp version currently in remote history:
supabase migration list

# Revert them all in one call (paste the timestamps you see, space-separated):
supabase migration repair --status reverted \
  20260609123129 20260609123155 20260609123249 20260609150304 20260609161747 \
  20260609162658 20260609164624 20260610005430 20260610011135 20260610011700 \
  20260610101215 20260610215215 20260610231232 20260610231340 20260610231751 \
  20260611005829 20260611010013 20260611100515 20260611104338 20260611105331 \
  20260611120605 20260613163134 20260613195733 20260620012857 20260620015522 \
  20260620021045 20260620194218 20260620200348 20260620203031 20260620213714 \
  20260620213729 20260622103438 20260622103804 20260622104423 20260626122044 \
  20260626205049 20260627151502 20260627151511 20260627151515 20260627203631 \
  20260627213032 20260627214228
```

`--status reverted` **deletes** those rows from `schema_migrations`.

### Step 3 — Verify

```bash
supabase migration list
```

Every row should now show the **same** version in both Local and Remote columns
(`0001…0037`), with **no** leftover `20260…` rows on the remote side.

Then confirm push is a no-op:

```bash
supabase db push          # expect: "Remote database is up to date." (nothing applied)
```

If push instead tries to apply migrations or errors on "already exists", **stop** —
Step 1 didn't take. Re-check `schema_migrations` contents and re-run Step 1.

---

## 5. Fallback — do it directly in SQL (if the CLI balks at `00xx` versions)

`supabase migration repair` is the supported path and should accept the short
versions (the CLI already parses these files — that's how the original error compared
them). If your CLI version refuses non-timestamp versions, edit the table directly
(only `version` is `NOT NULL`):

```sql
-- Back up first (if you didn't in Step 0):
create table supabase_migrations.schema_migrations_backup_20260627 as
  table supabase_migrations.schema_migrations;

-- Replace the history with the repo's sequential versions:
begin;
delete from supabase_migrations.schema_migrations;
insert into supabase_migrations.schema_migrations (version, name) values
  ('0001','init'), ('0002','skills'), ('0003','invite_only'), ('0004','unified_prompts'),
  ('0005','webhooks'), ('0006','tools'), ('0007','activity_and_attachments'),
  ('0008','agents_and_mcp'), ('0009','webhook_agent'), ('0010','scheduled_agents'),
  ('0011','security_hardening'), ('0012','pdf_knowledge'), ('0013','workspace_knowledge'),
  ('0014','model_profiles'), ('0015','guardrails'), ('0016','email_integration'),
  ('0017','artifact_visualizations'), ('0018','plugins'), ('0019','openrouter_provider'),
  ('0020','forged_functions'), ('0021','webhook_function_target'), ('0022','webhook_secret'),
  ('0023','message_feedback'), ('0024','knowledge_notes'), ('0025','evals'),
  ('0026','evals_judge'), ('0027','feedback_summary'), ('0028','usage_tracking'),
  ('0029','user_tables'), ('0030','user_table_column_keys'), ('0031','loops'),
  ('0032','mcp_integration'), ('0033','collections'), ('0034','collection_token_stats'),
  ('0035','collections_combined_chars'), ('0036','mcp_servers'), ('0037','vault_secrets');
commit;
```

(The `name` values mirror the repo filenames; they're cosmetic — only `version`
drives `db push`.) Then re-run **Step 3** to verify.

---

## 6. After reconciliation — wire up "normal" CI

The repo on `main` already contains a `db push`-based
`.github/workflows/deploy-migrations.yml` (from PR #45). Once history is reconciled it
will work as intended. To finish:

1. **Keep the `SUPABASE_DB_PASSWORD` GitHub Actions secret** — `db push` needs it.
   (It's already set.) `SUPABASE_ACCESS_TOKEN` is the same PAT the functions workflow
   uses.
2. **Close PR #46** ("Fix migrations CI: apply via Management API") **without merging.**
   It was a stopgap that avoided reconciliation; this Path supersedes it. If you'd
   rather *not* reconcile, merge #46 instead and skip this whole document — but then
   you're not on the standard `db push` flow.
3. **Test end-to-end:** add a trivial migration (e.g. `0038_ci_smoke.sql` containing a
   harmless idempotent statement like
   `comment on table public.profiles is 'migrations CI verified';`), push to `main`,
   and confirm the **Apply database migrations** Action applies it and that a new
   `0038` row appears in `schema_migrations`.

> Sanity check on the workflow that will run: open `.github/workflows/deploy-migrations.yml`
> on `main` and confirm it runs `supabase db push` (PR #45 version), not the
> Management-API curl loop (PR #46 version). If #46 was merged, revert that file to the
> `db push` version before relying on this flow.

---

## 7. Gotchas / do-NOT

- **Do NOT run `supabase db reset`** — it drops and recreates the database (data loss).
- **Do NOT `supabase db push` between Step 1 and Step 2.** With local marked applied but
  timestamps still present, push still errors on the leftover remote-only versions.
  Finish both steps, then push.
- **Going forward, migrations must be added as CLI-style files** (`0038_…`, `0039_…`).
  Do **not** keep applying via the Management API / MCP `apply_migration` — that would
  re-introduce timestamp rows and desync the history again. Pick one source of truth:
  the repo + `db push`.
- The `authoring_builtins` (`20260627214228`) and `vault_secrets` (`20260627213032`)
  rows are migrations applied out-of-band during this work. Their **schema is already
  live**; reverting their bookkeeping rows is correct (the equivalent objects are
  covered by repo files `0037` and whatever introduced the extra builtins). If
  `authoring_builtins` corresponds to schema **not** represented by any repo file,
  capture it as a new repo migration (`0038_authoring_builtins.sql`) **before** relying
  on `db push`, so the repo stays the complete source of truth. Quick check:
  `supabase db diff --linked` should report **no** differences once you're done; if it
  shows drift, codify that drift as the next repo migration.

---

## 8. Validation checklist

- [ ] `schema_migrations_backup_*` table exists (restore point).
- [ ] `supabase migration list` shows aligned `0001…0037` on both sides, no `20260…` rows.
- [ ] `supabase db push` prints "Remote database is up to date."
- [ ] `supabase db diff --linked` reports no schema drift (or drift was codified as a new repo migration).
- [ ] `SUPABASE_DB_PASSWORD` + `SUPABASE_ACCESS_TOKEN` secrets present in GitHub Actions.
- [ ] `.github/workflows/deploy-migrations.yml` on `main` is the `db push` version.
- [ ] PR #46 closed (or intentionally merged instead, skipping reconciliation).
- [ ] Smoke-test migration `0038_*` auto-applied by the Action and recorded in `schema_migrations`.
```
