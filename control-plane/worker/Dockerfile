# SupaNet provisioning worker — polls the control-plane Supabase for queued
# provisioning_jobs and runs the engine (see control-plane/worker/index.ts).
#
# Build context must be the REPO ROOT (the engine reads supabase/migrations and
# supabase/functions from the checkout to build each tenant). On Railway: set
# the service variable RAILWAY_DOCKERFILE_PATH=control-plane/worker/Dockerfile
# and leave Root Directory unset. Provider-neutral: the same image runs on any
# Docker host — env contract in control-plane/.env.example.

FROM node:22-slim

WORKDIR /app

# The worker only needs the repo files + control-plane deps. npm ci includes
# devDependencies by default — required: tsx runs the TypeScript directly.
COPY . .
RUN cd control-plane && npm ci

CMD ["npm", "--prefix", "control-plane", "run", "worker"]
