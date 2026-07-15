# office-worker container. BUILD CONTEXT MUST BE `workers/` (the workspace root),
# because this service depends on the @supanet/worker-shared workspace package.
# In Railway: set the service's root directory to `workers` and the Dockerfile
# path to `office-worker/Dockerfile`.
#
# Ships LibreOffice (soffice) for document conversion/rendering and poppler-utils
# (pdftoppm) for PDF→PNG previews. Pinned base image + pinned deps.
FROM node:20-bookworm-slim

# LibreOffice headless + PDF rasterizer + a font set so rendered previews aren't
# blank. --no-install-recommends keeps the image lean.
RUN apt-get update && apt-get install -y --no-install-recommends \
    libreoffice-writer libreoffice-calc libreoffice-impress \
    poppler-utils fonts-dejavu fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

ENV HOME=/tmp
WORKDIR /app

# Install workspace deps (root manifest + each workspace's package.json first for
# better layer caching).
COPY package.json ./
COPY shared/package.json ./shared/
COPY office-worker/package.json ./office-worker/
COPY media-worker/package.json ./media-worker/
RUN npm install --workspaces --include-workspace-root

# Build shared, then the office worker.
COPY shared ./shared
COPY office-worker ./office-worker
RUN npm run build -w @supanet/worker-shared && npm run build -w @supanet/office-worker

ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "office-worker/dist/index.js"]
