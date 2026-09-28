# Stack & conventions — what a vibe-coded app is made of

This is the shape every app on the house stack reproduces. The reference
implementation is the repo this skill lives in; when in doubt, open the real file
named here and copy its pattern rather than inventing one.

## The stack

- **Frontend:** React 18 · TypeScript · Vite · Tailwind CSS · React Router. Built with
  `tsc -b && vite build`; served as a static SPA (`serve -s dist`, SPA fallback).
- **Backend:** Supabase — Postgres + RLS, Auth, Realtime, Storage, Edge Functions (Deno).
- **AI (only if the app needs it):** any model via OpenRouter, behind a streaming edge
  function. The key is a server-side edge secret, never in the browser.
- **Hosting:** static frontend on Railway (Nixpacks build → `serve`); Supabase is the
  backend. `main` is the deploy branch for both.

## Security defaults (non-negotiable)

These come from this repo's `CLAUDE.md` "Database & security model" and hold for every
app you scaffold:

- **RLS is the boundary.** Every table has RLS enabled with policies from creation.
  Owner-only tables use `owner_id = auth.uid()` (`profiles` uses `id = auth.uid()`).
  Rows open to others only when a column explicitly says so (e.g. `visibility <> 'private'`).
- **The browser holds only the anon/publishable key.** Data safety is RLS, not key
  secrecy. Service-role keys and provider API keys never reach the client bundle.
- **Real secrets live in Supabase Vault** (or as edge-function / CI secrets), reached
  only by the service role through security-definer RPCs — never a table column, never a
  client payload, never a log line.
- **Invite-only by default.** `profiles.is_admin` (first signup = admin); a
  `BEFORE INSERT` guard on `auth.users` rejects signups unless it's the first user or the
  email is in an admin-managed `allowed_emails` table. Flip to open signup only if asked.
- **A trigger auto-creates a `profiles` row on signup** (`handle_new_user`); trigger
  functions have `EXECUTE` revoked from API roles and a pinned `search_path`.
- **Edge functions that face the public are `verify_jwt = false`** and gated in code by
  an unguessable token / HMAC / per-user token; user-facing ones stay `verify_jwt = true`.
  `verify_jwt` is declared per function in `supabase/config.toml` so a plain deploy can't
  silently flip it.

Copy these from the reference `supabase/migrations/0001_init.sql` — don't re-derive the
`profiles` trigger, the invite-only guard, or the RLS boilerplate from memory.

## Starter file manifest

A freshly scaffolded app should contain at least:

```
src/
  contexts/AuthContext.tsx     Supabase Auth (session, sign in/up/out) + useAuth()
  components/ProtectedRoute.tsx Redirects to /login when signed out
  pages/LoginPage.tsx          Email/password + magic link
  pages/…                      The app's own screens, behind ProtectedRoute
  lib/supabase.ts              createClient<Database>(url, anonKey) from VITE_* vars
  lib/database.types.ts        Typed schema (npm run gen:types keeps it in sync)
supabase/
  migrations/0001_init.sql     Tables + RLS + profiles trigger + invite-only guard
  functions/<name>/index.ts    Only the edge functions the app actually needs
  config.toml                  verify_jwt per function
.github/workflows/
  test.yml                     lint + build + tests on PRs and pushes to main
  deploy-functions.yml         supabase functions deploy on function changes to main
  deploy-migrations.yml        supabase db push on migration changes to main
railway.json                   Nixpacks build + serve config
.env.example                   VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY placeholders
package.json                   build = tsc -b && vite build; start = serve -s dist
README.md / DEPLOY.md          how to run and deploy this specific app
```

De-parameterize when copying the workflows: the Supabase project ref must come from a
repo **variable** `SUPABASE_PROJECT_REF` (with a default), not a value hardcoded to the
reference project. See the copied workflow headers for the exact secret/variable names.

## CI/CD contract (how `main` stays live)

Once the repo secrets/variables are set (see `provisioning.md`), merging to `main`:

1. **Railway** rebuilds and re-serves the frontend (auto-deploy from the connected repo).
2. **`deploy-functions.yml`** runs `supabase functions deploy` when anything under
   `supabase/functions/**` or `config.toml` changed.
3. **`deploy-migrations.yml`** runs `supabase db push --include-all` when anything under
   `supabase/migrations/**` changed — applying only pending migrations (the remote tracks
   applied versions), so it's safe to re-run.

After the one-time secret setup, nobody runs `supabase` commands by hand again. That's
the whole point: the app evolves by editing files and merging.

## Conventions carried from CLAUDE.md

- **Keep testable logic out of components** and in pure modules with unit tests (the
  reference repo puts parsers/validators in `src/lib/*` and `supabase/functions/_shared/*`).
  `npm run build` + `npm test` (and `npm run test:deno` if you touched functions) gate a push.
- **Never hardcode a model id.** If the app uses AI, resolve the model through a
  `model_profiles`-style row, with `OPENROUTER_MODEL` only as a fallback.
- **Migrations are the single source of truth** for schema; regenerate
  `database.types.ts` after any schema change and re-check Supabase security advisors.
- **Trunk-based:** commit to `main`, run `npm run build` first, hosting auto-deploys.
  (This differs from *this* task's own branch rules — those govern how you deliver the
  skill itself, not how the scaffolded app is run day to day.)
