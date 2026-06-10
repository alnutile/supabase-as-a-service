# syntax=docker/dockerfile:1
# check=skip=SecretsUsedInArgOrEnv
#
# Why the check is skipped: VITE_SUPABASE_ANON_KEY is PUBLIC by design. It is the
# Supabase anonymous/publishable key — Vite inlines it into the browser bundle,
# and Postgres row-level security (not secrecy) protects the data. BuildKit only
# flags it because the name contains "KEY". The real secret (ANTHROPIC_API_KEY)
# is a Supabase edge-function secret and never enters this build.

FROM node:20-alpine
WORKDIR /app

# Install deps first for better layer caching.
COPY package*.json ./
RUN npm ci

# App source.
COPY . .

# Build-time public config (Railway passes service variables to these ARGs).
ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_ANON_KEY
ENV VITE_SUPABASE_URL=$VITE_SUPABASE_URL
ENV VITE_SUPABASE_ANON_KEY=$VITE_SUPABASE_ANON_KEY

RUN npm run build

EXPOSE 8080
# Serves dist/ with SPA fallback on $PORT (Railway sets it).
CMD ["npm", "run", "start"]
