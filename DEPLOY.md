# Deploying

Two pieces go live: the **Supabase backend** (database, auth, storage, realtime, the `chat` edge function) and the **React frontend** (hosted on Railway as a static build).

## 1. Supabase backend

1. Apply the schema: run `supabase/migrations/0001_init.sql` (SQL editor or `supabase db push`).
2. Deploy the AI function and its secret:
   ```bash
   supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
   supabase functions deploy chat
   ```
3. Grab **Project URL** and **anon/publishable key** (Project Settings → API).

## 2. Frontend on Railway

Railway builds the Vite app from the committed **`Dockerfile`** (`railway.json` sets `builder: DOCKERFILE`) and serves the static output with `serve`.

1. In Railway: **New Project → Deploy from GitHub repo** → pick this repo (`main`).
2. Add **service variables** (read at *build* time — Vite inlines them into the bundle; the Dockerfile declares them as `ARG`s so Railway passes them through):
   - `VITE_SUPABASE_URL` = your Supabase project URL
   - `VITE_SUPABASE_ANON_KEY` = your anon/publishable key (public by design — RLS protects the data)
3. Deploy. The Dockerfile runs `npm ci` → `npm run build`, then `npm run start` serves `dist/` on `$PORT` with SPA fallback.
4. Open the generated Railway URL. Add that URL to Supabase **Auth → URL Configuration → Site URL / Redirect URLs** so magic links and email confirmations redirect back correctly.

### Notes
- `VITE_*` variables must exist **before the build runs**. If you add them after the first deploy, trigger a redeploy so they get baked in.
- The Anthropic key lives only as a Supabase edge-function secret — never in Railway, never in the bundle.
