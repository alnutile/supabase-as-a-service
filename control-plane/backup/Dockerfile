# SupaNet tenant backups — run-to-completion job (see control-plane/backup/index.ts).
# On Railway it is a cron service (infra/railway/tenant-backup.json): Railway
# starts the container on schedule and it exits when the run is done.
#
# Build context is the REPO ROOT (same as the provisioning worker), so the job
# can reuse control-plane/engine. pg_dump comes from the PGDG repo so its major
# version (17) is >= every tenant's Postgres — Debian's stock client is older
# and pg_dump refuses to dump a newer server.

FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl gnupg \
 && install -d /usr/share/postgresql-common/pgdg \
 && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
 && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" > /etc/apt/sources.list.d/pgdg.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends postgresql-client-17 \
 && apt-get purge -y gnupg curl && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY control-plane/package.json control-plane/package-lock.json control-plane/
RUN cd control-plane && npm ci
# Only the code the job runs — never control-plane/.env or a host node_modules.
COPY control-plane/tsconfig.json control-plane/
COPY control-plane/engine control-plane/engine
COPY control-plane/backup control-plane/backup

# Railway runs `npm start` from WORKDIR regardless of CMD (learned on the
# provisioner), so point both at the backup script explicitly.
WORKDIR /app/control-plane
CMD ["npm", "run", "backup"]
