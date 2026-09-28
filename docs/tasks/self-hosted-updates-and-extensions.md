# Handoff: self-hosted updates + extension contract (the "WordPress" layer)

> **Purpose of this file.** Continue a design discussion (no code was written) about
> letting people run their **own** copy of this intranet, WordPress-style: pull upstream
> updates *and* modify their intranet without the two colliding. This is the **complement**
> to [`one-command-install-and-hosted.md`](./one-command-install-and-hosted.md): that doc
> solves *provisioning* (how a workspace gets stood up); this one is *lifecycle* (how it
> gets updated and extended after that). Read that doc first — it already commits to
> **project-per-tenant / self-hosted**, which is the topology decision below.

---

## ▶ START HERE — first action for the new session

The reason this handoff exists: the **intranet MCP server was not connected** in the prior
session, so we couldn't pull the user's own research. Do this first:

1. Confirm the intranet MCP is connected — look for `mcp__intranet__*` tools
   (`get_collection`, `list_collections`, …). If they're missing, tell the user and have
   them enable the intranet connector for the chat (Settings → Connect Claude / `mcp_tokens`).
   The generic "Supabase" connector is **not** the same thing and was not enabled.
2. Pull the collection **"Supanet - Claude Connection"** via
   `mcp__intranet__get_collection` (name lookup; include artifacts + files + links + notes).
   This is the user's own research on the intranet MCP / "Supanet ↔ Claude" connection.
3. Fold that research into **Thread 3 → "stable extension API"** below — it's expected to
   sharpen exactly the contract that extensions bind to.

Reference the `intranet-workspace` skill for how to drive the intranet MCP.

---

## Where we are — decisions locked

- **Topology = self-hosted per tenant** (WordPress.org model; user chose this explicitly).
  Each customer runs their own Supabase project + frontend deploy. Matches the
  project-per-tenant decision already in `one-command-install-and-hosted.md`. Multi-tenant
  is rejected (would be a rewrite; the whole security model assumes one company per project).
- The architecture is **already "core code vs. config-as-data"**, which is the WordPress
  split. Most user creations (Forge functions, tools, agents, skills, collections,
  artifacts, `ut_*` tables) already live as **rows in the tenant's DB**, not files in the
  repo — so they structurally can't collide with a core code update. That's the big head
  start over WordPress (whose plugins are PHP files on disk that *do* conflict).

## Thread 1 — `@supabase/server` (`npm:@supabase/server`, public beta)

The question that kicked this off. Verdict: **not worth adopting for a refactor now**, but
it is **the right primitive for the scoped-DB apps** in Thread 2.

- What it does: `withSupabase({ auth: 'user' })` collapses the per-function boilerplate —
  makes a user-scoped client + admin client, verifies the JWT (incl. new asymmetric signing
  keys), handles CORS. Multi-runtime.
- **Camp A (would benefit):** the `verify_jwt: true` functions doing the standard "verify
  session → user client + service client" dance — `chat`, `link-meta`, `mcp-admin`,
  `openrouter-balance`, `forge`.
- **Camp B (would NOT benefit — most public functions):** `webhook`, `mcp`,
  `message-inbound`, `email-inbound`, `run-tool`, `event-dispatch`, `scheduler`,
  `slack-events`, `p`, `artifacts`, `todos` — all `verify_jwt:false` **on purpose**, using
  bespoke auth the package can't model (`mcp_tokens` bearer → run *as token owner*, HMAC for
  Slack, opaque webhook token/secret, cron-secret) and mostly running as the **service role**
  and re-enforcing access in code — the opposite of the user-scoped client.
- Recommendation: skip for now (small dedup, it's beta, would leave two auth patterns). The
  one thing to track: **asymmetric JWT signing keys** — if/when the workspace migrates to
  Supabase's new signing keys, the package handles verification automatically.

## Thread 2 — vibe-coded apps with scoped DB access ("only these 4 people can see my charts and query the DB via my app")

This is where `@supabase/server` earns its place. Today **Forge functions get no DB access**
("pure compute + `fetch()` only") and **standalone HTML hosting** (`/p/:slug`, `ArtifactFrame`)
runs in an **opaque-origin sandbox with no credentials** — neither can query the DB.
`withSupabase({ auth:'user' })` is the missing middle: verify the *viewer's* JWT → query the
DB **as that viewer under RLS**, no service role in the generated code.

The ask decomposes into two layers:
1. **"query as themselves" → RLS + the user-scoped client.** Near-free with the package.
2. **"only these 4 people" → an allowlist you build.** RLS governs *what data* a user sees,
   not *who may open this app*. Add a small `app_viewers` record (app_id → user_ids, same
   private/workspace pattern as everything else) and check `auth.uid()` before serving. Small.

**Architectural tension to resolve (flagged, not decided):** the sandbox strips credentials
*by design* (user HTML must never run with a session on the app origin). Two clean routes for
a vibe-coded app to query as the viewer:
- **Parent-injects-data** (mirrors the interactive-artifacts postMessage bridge): app stays
  sandboxed/credential-free; the authed parent runs the RLS query and passes results down.
  Best for bounded "my charts" datasets; no new backend.
- **Backend endpoint with the viewer's JWT** (where `@supabase/server` shines): app calls a
  Deno fn wrapped in `withSupabase({auth:'user'})`; fn does the allowlist check, queries under
  RLS as the viewer, returns JSON. Generalizes to arbitrary "query the DB via my app."

These apps are the tenant's **"plugins/pages"** — see Thread 3's rule that they must be
**data** (forged fn + artifact + allowlist) and talk to core through a **stable API**, never
raw core tables, or they die on the next update.

## Thread 3 — self-hosted updates + the extension contract (the main new material)

Two hard problems, both about the **boundary between upstream code and tenant code**:
**(1) distribution/updates** and **(2) override-without-forking**. Get the boundary right and
both are easy; get it wrong and you're WordPress circa 2010 (everyone edits core, nobody can
update).

### 3a. The foundational decision: core-as-dependency, NOT core-as-fork
Today a tenant would fork the repo → editing any core file makes `git pull` a permanent
conflict. Instead: **make core a versioned package/template, tenant repo a thin shell.**
- Core (React app + edge functions + migrations) ships as `@yourorg/intranet-core@X.Y`.
- Tenant repo holds only: env, a `plugins/` dir, a version pin.
- **Update = bump the pin. Modify = add to `plugins/`.** They never touch the same files.
- This is a real refactor (extract core into a package/template; define the extension API)
  but it's *the* decision that makes the product updatable. Do it first.

### 3b. The update-safe extension contract — three surfaces, all outside core
1. **Data extensions — already built.** Forge fns (`forged_functions`), tools, agents,
   skills, artifacts, `ut_*` tables, viewer allowlists. Rows in the tenant DB; a core update
   can't collide with a row. Biggest head start.
2. **Frontend extension points — net-new work.** Generalize **`src/lib/nav.ts`** (already a
   single source of truth that Layout, the ⌘K palette, and Feature flags all read) into a
   **registry** a `plugins/` dir feeds: register a route / nav entry / dashboard card /
   settings panel without editing a core page. The "child theme" slot system.
3. **Config — already built.** env + Vault secrets + `feature_flags` (literally per-tenant
   plugin activation: hide/show core areas) + `integrations`.

Bind all three to a **stable internal API** (the existing REST fns `artifacts`/`todos`/
`run-tool`, RPCs, MCP) — **not raw core tables** — and version it ("extensions targeting v2
API compatible", à la WordPress "tested up to 6.4"). **← the user's "Supanet - Claude
Connection" research should sharpen this piece.**

### 3c. The migration collision problem (they've already been bitten)
`CLAUDE.md` records two prod migration-prefix collisions (a second `0056_*` that silently
never deployed; a duplicate `0065` that blocked every later migration). Self-hosting
multiplies this: upstream owns `migrations/00XX`; a tenant writing their own migration file
guarantees a sequence collision on the next pull. Rules:
- **Tenant schema only through runtime RPCs** (`create_user_table`, `add_user_column`) →
  `ut_*` tables. No migration files, no collision, survives every update. Enforce hard.
- If raw DDL is truly needed, give tenants a **separate migration namespace**
  (`migrations/tenant/`, its own history) so numbering never fights upstream's `00XX`.
- **Never** `ALTER` a core table or add to the `00XX` sequence.

### 3d. The update channel — ~60% already built
Reuse, don't rebuild:
- `deploy-migrations.yml` / `deploy-functions.yml` — apply pending migrations + redeploy
  functions idempotently.
- Forge **"Deploy maintenance" panel** (`deploy_core`, `CORE_SLUGS` allow-list) +
  `src/lib/functionSources.ts` (core source bundled via `import.meta.glob('?raw')`) — an
  in-app "update core functions" button **that already exists**.
- Railway auto-deploys the frontend.
- **Gap = version awareness:** a "you're on 1.4 → 1.6, here's the changelog + pending
  migration count" check (poll a releases feed) whose apply step reuses the above. Thin.

## Net-new work, in leverage order
1. Extract core into a versioned package/template + thin tenant shell (3a — the fork-vs-dep
   decision).
2. Frontend plugin registry (generalize `nav.ts` into route/nav/card/panel slots fed by
   `plugins/`).
3. Version-aware update channel on top of the maintenance panel (3d).
4. (Thread 2) `app_viewers` allowlist + a `withSupabase({auth:'user'})` "app data" fn pattern
   for scoped-DB vibe-coded apps.

## Open questions to resolve with the user
- Package/template vs. git-template as the core-distribution mechanism (npm pkg? base image?
  `create-supanet`-generated shell that pins a core version?). Ties into
  `one-command-install-and-hosted.md`'s bootstrap module.
- Does the frontend plugin registry ship as part of core v1, or after the package extraction?
- Exactly which stable-API surface extensions are allowed to touch (define the "public API"
  vs. "internal" line) — **the "Supanet - Claude Connection" research feeds this.**
- Parent-inject vs. viewer-JWT-backend as the default for scoped-DB apps (Thread 2 tension).

## Codebase anchors (so a cold session can ground itself fast)
- `src/lib/nav.ts` — single-source sidebar config (seed of the plugin registry).
- `supabase/functions/_shared/management.ts` — Management API path (Forge deploy / `deploy_core`).
- `src/lib/functionSources.ts` — core fn source bundled into the UI for in-app redeploy.
- `ForgePage` + `forge` fn + `forged_functions` — backend code as data (the plugin system).
- `feature_flags` (migration 0065) — per-tenant show/hide of core areas.
- `user_tables` + `ut_*` (migration 0029) — tenant schema that already survives core migrations.
- REST fns `artifacts` / `todos` / `run-tool`, and the MCP server (`functions/mcp/`) — the
  candidate stable extension API.
- `docs/tasks/one-command-install-and-hosted.md` — the provisioning half; read alongside this.
- `WHY.md` — the buyer (office manager, 5–50-person services firm) the whole thing serves.
