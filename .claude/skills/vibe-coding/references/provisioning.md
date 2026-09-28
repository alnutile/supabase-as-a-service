# Provisioning reference — exact calls per provider

The concrete API / MCP / CLI moves for taking a scaffolded app live, and an honest map
of what is automated today versus what still needs a human. Prefer MCP tools when they
exist (no local creds, no shelling out); fall back to the Management/REST API or CLI for
the gaps. Every token below is a real credential — it lives in the environment or Vault,
**never** in the repo or a commit.

---

## Supabase — fully automatable (MCP)

All via the connected `mcp__Supabase__*` tools; no CLI needed for the core path.

1. **Pick the org & price it**
   - `list_organizations` → choose the org id.
   - `get_cost { type: "project", organization_id }` → `confirm_cost` (returns an id you
     pass to `create_project`). A new project on a paid org has a cost; surface it.
2. **Create the project**
   - `create_project { name: "<slug>", organization_id, confirm_cost_id, region? }`.
   - Poll `get_project` / `list_projects` until status is healthy before migrating. New
     projects have a brief window where the `storage` schema lags — if a migration's
     storage section fails, retry it (known race, called out in CLAUDE.md).
3. **Apply the schema**
   - `apply_migration { project_id, name, query }` for each file in
     `supabase/migrations/`, in numeric order. Keep the file's name as the migration name.
4. **Deploy edge functions**
   - `deploy_edge_function { project_id, name, files }` for each function the app ships.
   - `verify_jwt` follows `supabase/config.toml`; keep public/token-gated functions at
     `verify_jwt = false` there.
5. **Grab the frontend credentials**
   - `get_project_url { project_id }` → `VITE_SUPABASE_URL`.
   - `get_publishable_keys { project_id }` → `VITE_SUPABASE_ANON_KEY`.
6. **Verify security**
   - `get_advisors { project_id, type: "security" }` → resolve every finding (a table
     without RLS shows up here). This is the gate for "done."

### Supabase gaps not covered by MCP (do via Management API or CLI)

- **Edge-function secrets** (`OPENROUTER_API_KEY`, cron config, etc.):
  - CLI: `supabase secrets set OPENROUTER_API_KEY=sk-or-... --project-ref <ref>`
  - Management API: `POST https://api.supabase.com/v1/projects/{ref}/secrets`
    with `Authorization: Bearer $SUPABASE_ACCESS_TOKEN`, body
    `[{"name":"OPENROUTER_API_KEY","value":"sk-or-..."}]`.
    (Secret names can't use the reserved `SUPABASE_` prefix.)
- **Auth Site URL + redirect allowlist** (the "confirmation link goes to localhost" fix):
  - Management API: `PATCH https://api.supabase.com/v1/projects/{ref}/config/auth`
    with `{ "site_url": "https://<app>.up.railway.app",
    "uri_allow_list": "https://<app>.up.railway.app,https://<app>.up.railway.app/**" }`.
  - Do this **after** you know the Railway URL (phase 4 → phase 5 in SKILL.md).

`SUPABASE_ACCESS_TOKEN` is a Supabase personal access token (Dashboard → Account →
Access Tokens) — the same kind the deploy workflows use.

---

## GitHub — repo + push automatable; Actions secrets are the gap

Via `mcp__github__*`:

- `get_me` first (confirm the account / permissions).
- `create_repository { name: "<slug>", private: true, autoInit: false }`.
- `push_files { owner, repo, branch: "main", files:[...], message }` — push the whole
  scaffold in one commit. (Or `create_or_update_file` per file for small trees.)

### The honest gap: Actions secrets & variables

The GitHub MCP tools available here **cannot** set repository secrets or variables. The
deploy workflows need these three, or they fail on the first run:

| Kind | Name | Value |
| --- | --- | --- |
| Variable | `SUPABASE_PROJECT_REF` | the new project's ref |
| Secret | `SUPABASE_ACCESS_TOKEN` | Supabase PAT (reuse the one above) |
| Secret | `SUPABASE_DB_PASSWORD` | project DB password (Dashboard → Project Settings → Database) |

Two ways to set them:

1. **GitHub REST secrets API** (scriptable, needs a token with `repo` + `actions:write`):
   - `GET /repos/{owner}/{repo}/actions/secrets/public-key` → `{ key, key_id }`.
   - Encrypt each value against `key` with libsodium sealed box (e.g. Node `tweetnacl`
     + `tweetnacl-sealedbox-js`, or `libsodium-wrappers` `crypto_box_seal`).
   - `PUT /repos/{owner}/{repo}/actions/secrets/{SECRET_NAME}` with
     `{ encrypted_value, key_id }`.
   - Variables are plaintext: `POST /repos/{owner}/{repo}/actions/variables`
     with `{ "name":"SUPABASE_PROJECT_REF", "value":"<ref>" }`.
2. **Manual** (the realistic fallback): give the user the 3-row table above and the path
   **Settings → Secrets and variables → Actions**. Two secrets + one variable, ~60s.

Do not report the GitHub phase as "hands-off" if you used the manual fallback — say the
repo and push were automated and these three entries were handed off.

---

## Railway — automatable with a token, else one-click

The frontend is a static Vite build; `railway.json` + the `start` script are already in
the scaffold. `VITE_*` vars are **build-time** — set them *before* the first build.

### Path A — Railway API (unattended, needs `RAILWAY_TOKEN`)

Railway's public GraphQL API is at `https://backboard.railway.app/graphql/v2`
(`Authorization: Bearer $RAILWAY_TOKEN`). The moves:

1. Create a project (`projectCreate`).
2. Create a service from the GitHub repo (`serviceCreate` with the repo source), branch
   `main`.
3. Set service variables `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`
   (`variableCollectionUpsert`).
4. Trigger a deploy (`serviceInstanceDeploy` / redeploy).

Confirm the current GraphQL field names against Railway's docs before relying on them —
they version the schema.

### Path B — one-click deploy button (no token, one authorize + one click)

Hand the user a URL of the form:

```
https://railway.app/new/template?template=<github-repo-url>&VITE_SUPABASE_URL=<url>&VITE_SUPABASE_ANON_KEY=<anon-key>
```

They authorize Railway to the repo once and click Deploy; the `VITE_*` values arrive
pre-filled. This is the default until a `RAILWAY_TOKEN` is wired up.

After the URL is live, do the **Supabase auth Site URL** PATCH above so redirects work.

---

## Credentials checklist (where each token comes from, where it lives)

| Token | Where to get it | Where it may live |
| --- | --- | --- |
| `SUPABASE_ACCESS_TOKEN` | Supabase Dashboard → Account → Access Tokens | env / CI secret |
| `SUPABASE_DB_PASSWORD` | Dashboard → Project Settings → Database | CI secret only |
| `OPENROUTER_API_KEY` | openrouter.ai/keys | Supabase edge secret only |
| GitHub token (for secrets API) | GitHub → Developer settings → Tokens (`repo`, `actions`) | env only |
| `RAILWAY_TOKEN` | Railway → Account → Tokens | env only |

None of these belong in the scaffolded repo or any commit. The anon/publishable key is
the only credential that ships to the browser, and it's safe there because RLS — not key
secrecy — protects the data.
