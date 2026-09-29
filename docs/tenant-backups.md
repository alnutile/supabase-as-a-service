# Tenant backups (S3)

Nightly off-platform backups of every tenant Supabase project into an S3 bucket
you own. Code: `control-plane/backup/` · Railway config: `infra/railway/tenant-backup.json`.

## What a run does

For every tenant in the control-plane `tenants` table with status
`active | past_due | canceled` (plus any refs in `BACKUP_EXTRA_REFS`):

1. **Database** — `pg_dump --format=custom` of `public`, `auth`, `storage`,
   `supabase_migrations` → `db/<ref>/<timestamp>.dump`. The archive is checked
   with `pg_restore --list` before it is uploaded.
2. **Storage** — every object in `storage.objects` is mirrored to
   `storage/<ref>/<bucket>/<path>`. Incremental: only new or changed objects are
   copied. Objects deleted in Supabase stay in S3.
3. **Summary** — `runs/<timestamp>.json` lists every tenant's result. Each tenant
   also gets a `backup.ok` / `backup.error` row in the control-plane `cp_events`.

Any failure makes the job exit non-zero and posts to `BACKUP_ALERT_WEBHOOK` if
it is set. One tenant failing doesn't stop the others.

### No DB passwords needed

The provisioner throws tenant DB passwords away, so each dump signs in with a
**temporary login role** from the Management API
(`POST /v1/projects/{ref}/cli/login-role`, the mechanism `supabase link` uses).
Only the org PAT is needed. The job tries the read-only role first. If that role
can't see every row (RLS), it falls back to the postgres-member role. Each dump
records which role it used in the object metadata. It connects through the
IPv4 Supavisor pooler in session mode (port 5432). The direct `db.<ref>` host is
IPv6-only, and Railway can't reach it.

## Setup

1. **S3 bucket** with versioning and a lifecycle rule. Pick your own names:

   ```bash
   B=supanet-tenant-backups-<suffix>; R=us-east-1
   aws s3api create-bucket --bucket $B --region $R
   aws s3api put-public-access-block --bucket $B --public-access-block-configuration \
     BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
   aws s3api put-bucket-versioning --bucket $B --versioning-configuration Status=Enabled
   aws s3api put-bucket-lifecycle-configuration --bucket $B --lifecycle-configuration '{
     "Rules": [
       {"ID":"db-dumps","Filter":{"Prefix":"db/"},"Status":"Enabled",
        "Transitions":[{"Days":30,"StorageClass":"GLACIER_IR"}],
        "Expiration":{"Days":90},"NoncurrentVersionExpiration":{"NoncurrentDays":1}},
       {"ID":"storage-history","Filter":{"Prefix":"storage/"},"Status":"Enabled",
        "NoncurrentVersionExpiration":{"NoncurrentDays":30}},
       {"ID":"runs","Filter":{"Prefix":"runs/"},"Status":"Enabled","Expiration":{"Days":90}}
     ]}'
   ```

   New buckets get SSE-S3 encryption by default.

2. **IAM user** that can only write to that bucket. It needs `s3:PutObject`,
   `s3:ListBucket`, and `s3:AbortMultipartUpload`, and should have no
   delete permission:

   ```bash
   aws iam create-user --user-name supanet-backup
   aws iam put-user-policy --user-name supanet-backup --policy-name s3-backup --policy-document '{
     "Version":"2012-10-17","Statement":[
       {"Effect":"Allow","Action":["s3:ListBucket"],"Resource":"arn:aws:s3:::'$B'"},
       {"Effect":"Allow","Action":["s3:PutObject","s3:AbortMultipartUpload"],"Resource":"arn:aws:s3:::'$B'/*"}]}'
   aws iam create-access-key --user-name supanet-backup
   ```

   Because the key has no delete permission and the bucket is versioned, a
   leaked key can't wipe your backups.

3. **Railway service.** In the control-plane Railway project (`supanet-control`),
   add a service from this repo on `main` with Root Directory unset. Railway has
   deprecated config-file paths, so set these in the service settings directly.
   `infra/railway/tenant-backup.json` records the intended values:
   `RAILWAY_DOCKERFILE_PATH=control-plane/backup/Dockerfile`, cron `0 7 * * *`,
   restart policy **Never**. The image's `npm start` and `npm run backup` both
   run the backup, so the frontend start command in the root `railway.json`
   can't hijack it. Then set these service variables:

   | Var | Value |
   | --- | --- |
   | `SUPANET_MGMT_PAT` | `${{provisioner-worker.SUPANET_MGMT_PAT}}`, a reference, so there's one copy |
   | `CONTROL_PLANE_REF` | control-plane project ref |
   | `BACKUP_EXTRA_REFS` | origin app ref, control-plane ref (optional) |
   | `BACKUP_S3_BUCKET` / `AWS_REGION` | from step 1 |
   | `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | from step 2 |
   | `BACKUP_ALERT_WEBHOOK` | Slack incoming webhook (optional, recommended) |

   The default schedule is `0 7 * * *` (07:00 UTC). A deploy also runs the job
   once. Check that `runs/<timestamp>.json` shows
   `"failed": 0`.

To run it locally, fill in the Backups block in `control-plane/.env`, put
`pg_dump` 17+ on your PATH, then run `cd control-plane && npm run backup`.

## Restore

Restore into a **new** Supabase project. Supabase creates the `auth` and
`storage` schemas itself, so restore their data only.

```bash
aws s3 cp s3://$B/db/<ref>/<timestamp>.dump tenant.dump
DB='postgresql://postgres.<newref>:<pw>@<pooler-host>:5432/postgres?sslmode=require'

# app schema + data, and the migration history
pg_restore --no-owner --no-privileges -n public -n supabase_migrations -d "$DB" tenant.dump
# users + storage metadata, triggers off while loading
PGOPTIONS='-c session_replication_role=replica' \
  pg_restore --data-only --no-owner -n auth -n storage -d "$DB" tenant.dump
```

Then:

- **Storage bytes.** Run `aws s3 sync s3://$B/storage/<ref>/ ./objects`, then
  upload each object back to the same `<bucket>/<path>` with upsert. The
  `storage.objects` rows are already restored.
- **Edge functions.** Run `supabase functions deploy --project-ref <newref>` and
  set the function secrets again.
- **Crons.** Call `setup_automation_cron`. `scripts/apply-migrations.ts` does this.
- **Vault secrets.** Re-enter them in Settings. Vault ciphertext is tied to the
  old project's key and won't decrypt anywhere else.
- **Control plane.** Point the tenant row's `project_ref` at the new project,
  and point the tenant's Railway env at the new URL and keys.

## Not covered

- Vault secret values (see above). Edge-function secrets live outside the database.
- `cron`, `net`, `realtime`, and other Supabase-managed schemas. These are
  rebuilt by migrations and `setup_automation_cron`.
- Point-in-time recovery. This is a daily snapshot. For PITR, use Supabase's
  paid-plan add-on.
