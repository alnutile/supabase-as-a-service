# media-worker (ffmpeg) container. BUILD CONTEXT MUST BE `workers/` (the
# workspace root), because this service depends on the @supanet/worker-shared
# workspace package. In Railway (or any provider): set the service's root
# directory to `workers` and the Dockerfile path to `media-worker/Dockerfile`.
#
# Ships ffmpeg (+ ffprobe). Pinned base image + pinned deps. Nothing here is
# provider-specific — the same image runs on Docker Compose, Railway, Fly, etc.
FROM node:20-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

ENV HOME=/tmp
WORKDIR /app

COPY package.json ./
COPY shared/package.json ./shared/
COPY office-worker/package.json ./office-worker/
COPY media-worker/package.json ./media-worker/
RUN npm install --workspaces --include-workspace-root

COPY shared ./shared
COPY media-worker ./media-worker
RUN npm run build -w @supanet/worker-shared && npm run build -w @supanet/media-worker

ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "media-worker/dist/index.js"]
