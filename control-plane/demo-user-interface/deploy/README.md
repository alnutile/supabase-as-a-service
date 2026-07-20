# SupaNet Landing

Self-contained marketing landing page for SupaNet. `index.html` has all fonts and assets inlined — no build step, no external requests.

## Deploy on Railway

**Option A — from this GitHub repo (recommended)**
1. Push this folder to a GitHub repo.
2. In Railway: New Project → Deploy from GitHub repo → pick it.
3. Railway detects `package.json` and runs `npm start`, which serves `index.html` on `$PORT`. Done.

**Option B — Railway CLI, no GitHub**
1. `npm i -g @railway/cli`
2. From this folder: `railway init` then `railway up`.

## Local preview
```
npx serve -s .
```
