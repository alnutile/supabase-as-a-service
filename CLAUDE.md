# CLAUDE.md

Guidance for AI agents (and humans) working in this repository.

## What this is

A React intranet layer on top of Supabase: auth, an AI chat assistant, shareable
"artifacts" (docs/code/HTML), file storage, and live realtime updates. The
OpenRouter key is server-side only (a Supabase Edge Function); the browser holds
just the Supabase anon key and is protected by Postgres row-level security.

## Commands

```bash
npm install            # install deps
npm run dev            # Vite dev server on http://localhost:5173
npm run build          # tsc -b (typecheck) + vite build — run before pushing
npm run lint           # eslint
npm run typecheck      # tsc -b --noEmit
npm run gen:types      # regenerate src/lib/database.types.ts from the linked project
npm run start          # serve dist/ with SPA fallback (production / Railway)
```

Always run `npm run build` before committing UI/logic changes — it typechecks the whole app.

## Architecture & data flow

- **Auth:** `src/contexts/AuthContext.tsx` wraps Supabase Auth (session, sign in/up,
  magic link, sign out). `ProtectedRoute` gates the authenticated app; routing is in
  `src/App.tsx`.
- **Chat:** `src/pages/ChatPage.tsx` writes user/assistant messages to Postgres and
  subscribes to `messages` via Supabase Realtime (websockets) for cross-device sync.
  The composer can **attach files** (📎): they upload to the `files` bucket (and show in
  Files), are stored on the message's `attachments` jsonb, and the chat function reads
  them — images/PDFs as content blocks, text inlined — so the assistant can parse them.
  Streaming comes from `src/lib/chat.ts` → `POST` to the `chat` edge function, which
  returns **SSE** lines `data: {"delta": "..."}` and ends with `data: [DONE]`.
  The function calls OpenRouter; the client only sends the message history + the user's
  access token (+ the anon key as the `apikey` header).
- **Artifacts:** `ArtifactsPage` (list/create) and `ArtifactEditorPage` (edit, preview,
  set visibility, delete). Public/unlisted artifacts are read anonymously by slug in
  `PublicArtifactPage` at route `/share/a/:slug`.
  **Standalone hosting:** an `html` artifact can also be served as a clean, chrome-free
  public page by the **public `p` edge function** (`verify_jwt: false`):
  `GET /functions/v1/p/‹slug›` returns the artifact's raw `content` as `text/html`
  (injecting `<title>`/OpenGraph tags + a permissive CSP + `nosniff`) — for sharing "a
  great diagram in HTML" with the public without deploying a whole app. It queries with
  the **anon key**, so RLS only ever returns non-private rows (private artifacts are
  invisible to it); only `type='html'` renders, anything else 404s. The editor's Sharing
  panel and `PublicArtifactPage` link out to it (`standalonePageUrl(slug)` in
  `src/lib/supabase.ts`). Because it serves straight from `artifacts.content`, editing the
  artifact updates the page live; an external/local AI app can also push HTML up (via MCP)
  to the same table and get the same URL. *(Planned: multi-file/bundled SPAs behind the
  same `p/‹slug›` URL via a public storage bucket; an MCP `publish_html` one-call helper.)*
- **Files:** `FilesPage` uploads to the private `files` storage bucket under
  `‹user-id›/…` and creates 7-day signed URLs for sharing.
- **Tables (Airtable-but-real-Postgres):** `TablesPage` (route `/tables`, sidebar,
  any member) lets a user create a data table — by hand or by describing it to AI —
  and edit rows in a spreadsheet-style grid. Each table is a **real Postgres table**
  (not EAV/JSONB) created in the `public` schema as `ut_‹uuid›`, so it keeps full SQL
  power and PostgREST exposes it for ordinary CRUD. **Browsers never run DDL:** all
  structural changes go through security-definer RPCs in migration 0029
  (`create_user_table`, `add_user_column`, `drop_user_column`, `update_user_table`,
  `drop_user_table`) that validate every identifier with `format(%I)` and an
  allow-list of column types (text/longtext/number/integer/boolean/date/datetime/json),
  so there's no injection surface even though any signed-in member can create tables.
  A registry table `public.user_tables` holds each table's metadata (display name,
  `physical_name`, `columns` spec, owner, `visibility`). **Access lives in one place:**
  `user_tables` RLS makes a row visible to its owner, to everyone when
  `visibility='workspace'` (collaborative read+write, like a shared base), or to admins;
  each physical `ut_*` table's single `for all` policy just checks "is the matching
  `user_tables` row visible?", so the physical tables inherit the registry's access
  logic. The RPCs honor an explicit owner only for the service role (auth.uid() wins for
  authenticated callers, so owner can't be spoofed) and `notify pgrst, 'reload schema'`
  after DDL so new tables/columns are queryable immediately. The assistant can use tables
  too: seeded `is_builtin` tools `list_tables` / `query_table` / `add_table_row` /
  `create_table` (in `_shared/builtins.ts`, so chat/agents/scheduler all get them) run
  with the service role and **re-enforce the private/workspace rule in code**; MCP exposes
  `list_tables` / `create_table` / `add_table_row` for an external Claude. *(Planned: a
  fuller query surface — sorting, richer filters/joins — and column reordering/rename.)*
- **PDF knowledge (RAG):** uploading a PDF enqueues a `documents` row (trigger on
  `files`). A `pg_cron` tick calls the `ingest` edge function, which extracts the
  text layer (`unpdf`), chunks it, embeds each chunk **free** with the in-edge
  `gte-small` model, and stores `document_chunks` in **pgvector**. Documents are
  **workspace-shared by default** (`documents.scope = 'workspace'`): any member's
  chat can search their chunks. The owner can flip a document to `'private'` in
  Files ("Only me"). RLS enforces this — members read `scope = 'workspace'` rows,
  chunks are readable by the owner or when the parent doc is shared, and only the
  owner can change scope. The seeded built-in `search_documents` tool runs
  `match_document_chunks` (cosine; `scope = 'workspace' OR owner = caller`,
  returns the document name for citations). Scope is **separate** from
  `files.visibility` — the raw PDF blob stays owner-private; only the text chunks
  are shared. Text-layer PDFs only for now (scanned → Stage 2 vision).
- **Activity:** `ActivityPage` is a live feed of `activity_log`. Rows are written by
  DB triggers (`webhook_events`, `artifacts`, `files`) and by the chat function (tool
  calls). RLS: you see your own rows, admins see all. Realtime-subscribed.
- **Webhooks:** `WebhooksPage` (master–detail) creates `webhooks` rows, each with an
  opaque `token` and an attached `prompt`. External systems POST to the **public**
  `webhook` edge function at `/functions/v1/webhook/‹token›` (`verify_jwt: false`); it
  resolves the webhook by token (service role), runs the prompt against the payload via
  Claude, and logs a `webhook_events` row (`received` → `ok`/`error`/`blocked`) with the
  result. The page subscribes to `webhook_events` over Realtime for a live log. Routing
  the result somewhere (artifact/chat/outbound) is a later step. A webhook-targeted agent
  runs **read-only by default** — its tools are loaded only when `webhooks.allow_tools = true`
  (a deterministic rule, not a model decision), so an untrusted source can't make the agent act.
  **Deterministic mode (n8n "function node"):** a webhook can instead set `webhooks.tool_id`
  (migration 0021) to call an `http` tool **directly** — no model. The webhook function
  validates the inbound payload against the tool's `input_schema` (required fields + top-level
  types via `validatePayload`), then POSTs it straight to the tool's `config.url` and logs the
  result; a bad payload returns a 400 listing the offending fields (`webhook_events` status
  `error`). No guardrail runs on this path because nothing reaches an LLM — schema validation
  *is* the gate. Mode precedence in the webhook function: `tool_id` (direct) → `agent_id`
  (agent loop) → `prompt`. This pairs with Forge: forged functions are `http` tools, so the
  editor's "Call a function directly" picker lists them, shows their fields/types, and renders
  a sample payload. Outcome logs as `activity_log` type `webhook.function`.
  **Optional shared secret (`webhooks.secret`, migration 0022):** the URL token is "secret-URL"
  security; setting a secret adds real auth — callers must present it as `Authorization: Bearer
  <secret>` or `X-Webhook-Secret: <secret>`, else the function returns 401 **before** logging an
  event (so a wrong/missing secret can't spam the event log). Null = no secret (unchanged). Set
  it per-webhook in the editor ("Require a secret"); it's a plaintext shared secret on the row,
  same trust model as `token`.
- **Prompts & skills:** one `skills` table, two modes.
  - `auto_apply = true` → **always-on** prompts (admin-managed, workspace-wide). The
    seeded `is_builtin` "How this workspace works" prompt teaches the assistant the
    system + the artifact protocol. The chat edge function loads all `auto_apply`
    rows (via service role) and concatenates them into the system prompt on every call.
  - `auto_apply = false` → **on-demand** skills (personal). In `ChatPage`, typing `/`
    (or the ⚡ button) lists them; `runSkill()` sends them as the `system` (artifact
    mode uses `replaceSystem: true` for clean output; reply mode appends to context).
- **Tools (tools-as-data):** the `tools` table defines capabilities the chat loop
  exposes to the model. `kind = 'http'` → a custom tool; the model calls it and the chat
  function POSTs the inputs to `config.url` and feeds the response back. `kind = 'web'`
  → switches on OpenRouter's **web plugin** (`plugins:[{id:'web'}]`), the portable
  replacement for Anthropic's server-side web tools (works with any OpenRouter model).
  Admin-managed (`ToolsPage`); a seeded `is_builtin` "web_browsing" row is on by default.
  The chat function runs an **agentic loop** (model → tool_calls → execute →
  tool result messages → … → stop), pushing the assistant turn (content + `tool_calls`)
  back before each batch of `{role:'tool'}` results (OpenAI/OpenRouter shape).
- **Guardrails:** the `guardrails` table holds admin-managed pre-flight checks evaluated
  by the cheap `utility` model profile **before** the orchestrator runs. `GuardrailsPage`
  (admin-only) manages them; each has `instructions` (what to check for), `applies_to_webhooks`
  / `applies_to_chat`, and `action` (`block` | `flag`). `runGuardrails()` in
  `supabase/functions/_shared/guardrails.ts` loads the active checks for the context, makes
  **one** `utility`-model call (plain `messages.create`, no thinking; content passed as
  untrusted data inside delimiters), and parses a strict-JSON verdict. **Enforcement is in
  code acting on the parsed JSON — the verdict is never inserted into the orchestrator's
  prompt.** Webhooks **fail closed** (an evaluator error blocks the run → `webhook_events`
  status `blocked`, 403); chat **fails open** (errors let the message through). A `block`
  verdict stops the run; `flag` only logs. Outcomes are written to `activity_log`
  (`guardrail.blocked` / `.flagged` / `.error`). A seeded `is_builtin` "Prompt injection
  screen" applies to webhooks and blocks. RLS mirrors `tools` (authenticated SELECT, admin
  write, builtin not deletable).
- **AI-created artifacts:** the assistant emits a `:::artifact {"title","type"}\n…\n:::`
  block; `materializeArtifacts()` in `ChatPage` parses it after streaming, inserts an
  `artifacts` row, and replaces the block with an `/artifacts/:id` share link.
  `SkillsPage` manages all of the above (always-on editing is admin-gated).
- **Agents:** an `agents` row is a deployable unit — a name + system prompt
  (`instructions`) + `tool_ids` it may use. `AgentsPage` is the dashboard (CRUD,
  workspace-visible). "Chat" opens `/chat?agent=:id`, where `ChatPage` layers the
  agent's prompt on the conversation and scopes the toolset to the agent's tools
  (`streamChat({ system, toolIds })` → chat function's `loadTools(restrictIds)`).
  A webhook can also **target an agent** (`webhooks.agent_id`): the webhook function
  then runs the agent (its prompt + tools) over the payload via its own tool loop
  instead of the bare prompt. **Scheduled agents:** a `schedules` row (agent + input +
  `interval_minutes`) is run by the `scheduler` edge function, which a `pg_cron` job
  ticks every minute (via `pg_net`, authed by a `cron_config` secret). Manage schedules
  inside the agent editor.
- **MCP server:** `supabase/functions/mcp/index.ts` is a JSON-RPC-over-HTTP MCP
  server (`verify_jwt: false`) an **external** Claude connects to. Auth is a per-user
  `mcp_tokens` token (Settings → Connect Claude); every action runs as the token's owner.
  **Claude Code** connects directly (`claude mcp add --transport http …`); **Claude
  Desktop** launches MCP servers as local processes, so it connects through the
  `mcp-remote` bridge in `claude_desktop_config.json` (Settings → Connect Claude emits
  both snippets; the `Authorization:${AUTH_HEADER}` env split avoids mcp-remote's
  space-in-header bug). It exposes build tools (`create_agent`, `create_http_tool`,
  `create_skill`, `create_webhook`, `create_artifact`, `list_*`) so an outside Claude can
  push agents/tools into the workspace, where they appear in the dashboard. *(Planned —
  see `docs/tasks/`: `upload_file` + a signed-URL pair to push files/PDFs into Files and
  the knowledge base, and a tabbed Code/Desktop connect UI.)*
- **Email:** two seeded `is_builtin` tools — `send_email` and `check_email` — let any
  user or agent use email once an admin configures a provider in **Settings → Email**.
  Sending goes through an HTTP provider (Postmark / Resend, not raw SMTP); receiving is
  **inbound-parse, not IMAP** — the provider POSTs each incoming mail to the public
  `email-inbound` edge function (`verify_jwt: false`, token-gated like `webhook`), which
  normalizes it into `inbox_messages`; `check_email` reads that table (push, not polling).
  **Credentials live only in Supabase Vault:** the non-secret config sits in
  `public.integrations` with a `secret_id` pointer; the client writes the key solely
  through the admin-gated, security-definer RPC `set_email_integration` (admin-checked in
  the body), and edge functions read the decrypted key through the service-role-only
  `read_email_secret`. The key is never a table column, never in a client payload, never
  logged. `send_email` is exfiltration-capable, so it stays an ordinary tool row (admin
  activation, agent `tool_ids` scoping, the `webhooks.allow_tools` gate all apply) and adds
  an optional recipient allowlist (exact address or `@domain` suffix), a 20-per-hour rate
  limit, and an `email.sent` activity-log entry per send. All three agent loops execute it
  via the shared `supabase/functions/_shared/builtins.ts` (`runBuiltin`), which also holds
  `search_documents` — so the "morning agent emails me" flow works through the scheduler,
  not just chat. *Planned follow-up (not built): email-triggered agents — run an agent per
  `inbox_messages` row.*
- **Plugins:** `PluginsPage` (route `/plugins`, in the sidebar) is a discovery + management
  surface for upstream Supabase Edge Function examples. The **catalog** of *available* plugins
  is a static, hand-maintained list in `src/lib/plugins.ts` (slug → name/description/category/
  required secrets) linking to each example's folder in the `supabase/supabase` repo — kept in
  the codebase so it's offline-readable and not subject to GitHub rate limits. The **installed**
  list is the `plugins` table (an in-app registry): admins "Add" a catalog entry once they've
  deployed it, can pause/enable it, keep setup notes, and remove it. The browser can't introspect
  actually-deployed functions (that needs a Management API token), so this table is the
  system-of-record an admin curates. RLS mirrors `tools`/`guardrails` (authenticated SELECT,
  admin write). Settings links here. *Planned follow-up (not built): one-click install — either
  an `install_plugin` MCP tool (Claude Code pulls the example into `supabase/functions` + deploys)
  or a server-side deploy via the Supabase Management API.*
- **Usage tracking:** every OpenRouter call returns a `usage` object (tokens + `cost`);
  the shared client surfaces it on `ORResult.usage` and `recordUsage()`
  (`supabase/functions/_shared/usage.ts`) writes one `usage_events` row per call from
  all four loops (chat/webhook/scheduler/guardrail). `UsagePage` (route `/usage`,
  admin-only) shows spend (totals, daily chart, by model/context/user via the
  `usage_summary(p_days)` security-definer RPC) and the OpenRouter account balance
  (the admin-only `openrouter-balance` edge function proxies `GET /api/v1/key`, since
  the key is server-side). RLS on `usage_events` mirrors `activity_log` (own-or-admin
  SELECT, service-role writes only). Visibility only — budgets/enforcement are a
  follow-up (ROADMAP items 2–3).
- **Forge (vibe-coded functions):** `ForgePage` (route `/forge`, admin-only) closes the
  "configuration-as-data can't deploy new code" gap. An admin describes a capability in
  natural language; the admin-only `forge` edge function (`verify_jwt: true`) generates a
  Deno function (orchestrator model), then **deploys it to the live project via the Supabase
  Management API** and registers it as a `kind='http'` tool — so chat/agents/webhooks/scheduler
  can call it like any custom tool. Use it for deterministic work the LLM can't do reliably
  (a calculator, a unit converter, a precise transform, a validate-then-call API). The
  generated code is just `async function handler(input)`; a **fixed harness** (`forge/template.ts`,
  `buildModule`) owns request handling, CORS, and a per-function `x-forge-token` check (baked
  into the deployed source, sent by the tool's `config.headers`), so the security-critical
  plumbing is never the model's to write. **Security:** admin-only at every entry; the
  Management API PAT lives ONLY in `supabase/functions/_shared/management.ts` (reads
  `FORGE_PAT`; the project ref auto-derives from `SUPABASE_URL`, override with `FORGE_PROJECT_REF`
  — note secrets cannot use the reserved `SUPABASE_` prefix); a static deny-list lint (`lintSource`) rejects
  generated code that touches `Deno.env`, the service-role key, the PAT, `mcp_tokens`,
  subprocesses, the filesystem, or `eval`; a `runGuardrails` pre-flight screens the code;
  forge **fails closed** (any lint hit, guardrail block/error, or `bundleOnly=1` dry-run
  failure aborts before the real deploy). Generated functions get **no DB/secret access** —
  pure compute + `fetch()` only. The `forged_functions` table (migration 0021) is the
  audit/redeploy system-of-record (spec, generated `source`, slug, model, status, invoke
  token, linked `tool_id`); RLS mirrors `tools` (migration 0020). Note: API-deployed functions
  don't live in the repo, so `forged_functions.source` is the redeploy source of truth and
  ToolsPage shows a "Forged" badge on the linked tool. Outcomes log to `activity_log` (`forge.deployed` /
  `.failed` / `.deleted`). *Planned follow-up (not built): DB-writing forged functions via
  admin-authored `security definer` RPCs; an `applies_to_forge` guardrail context; a
  `forge_tool` MCP action so Claude Code can forge tools too.*
- **In-app function deploys (edge functions don't ride `main`):** pushing to `main` redeploys the
  **frontend** (Railway) and DB migrations are applied out-of-band, but the Supabase **edge
  functions** only update via a `functions deploy` — so a code change to `chat`/`_shared/*` etc. is
  NOT live until deployed. Forge's "Deploy maintenance" panel (admin-only, on `ForgePage`) closes
  this from inside the app, reusing Forge's Management-API path (`_shared/management.ts`, now
  multi-file capable): **"Update core functions"** → forge `deploy_core` redeploys the repo
  functions (`chat`, `mcp`, `webhook`, `scheduler`, …) from their source **bundled into the UI at
  build time** (`src/lib/functionSources.ts` via `import.meta.glob('?raw')`, lazy-loaded so it
  never weighs down the main bundle); since the frontend auto-deploys from `main`, that bundled
  source is current as of the last deploy. **"Redeploy forged functions"** → `redeploy_all_forged`
  re-pushes every vibe-coded function's stored source. `deploy_core` is admin-only and **slug
  allow-listed** (`CORE_SLUGS`) so it can only (re)deploy known functions, never arbitrary ones;
  no lint runs (core functions legitimately use `Deno.env` + the service role). Outcomes log as
  `forge.deploy_core` / `forge.redeploy_all`. Bootstrapping note: the `forge` function itself must
  be deployed once (CLI/MCP) to gain these actions; after that it can redeploy everything,
  including itself.

## Directory map

```
src/
  App.tsx                      Routes (public: /login, /share/a/:slug; rest protected)
  contexts/AuthContext.tsx     Supabase Auth provider + useAuth()
  components/
    Layout.tsx                 App shell: responsive sidebar/drawer + top bar
    ProtectedRoute.tsx         Redirects to /login when signed out
    Markdown.tsx               react-markdown + remark-gfm renderer
    VisibilityControl.tsx      Private/Unlisted/Public toggle + copyable link
    icons.tsx                  Inline SVG icons (no icon dependency)
  pages/                       LoginPage, ChatPage, ArtifactsPage,
                               ArtifactEditorPage, PublicArtifactPage,
                               FilesPage, TablesPage, SkillsPage, WebhooksPage, ToolsPage,
                               AgentsPage, PluginsPage, ActivityPage, SettingsPage
  lib/
    supabase.ts                createClient<Database>(...) + chatFunctionUrl
    chat.ts                    streamChat(): SSE parser for the chat function
    plugins.ts                 Static catalog of upstream Edge Function examples
    database.types.ts          Typed schema (keep in sync with the migration)
    util.ts                    makeSlug, formatBytes, formatDate
supabase/
  migrations/                  0001 base … 0008 agents/MCP; 0012 PDF knowledge; 0014 model profiles; 0015 guardrails; 0016 email/Vault; 0018 plugins registry; 0019 OpenRouter provider; 0020 usage tracking; 0029 user tables (Airtable-like real Postgres tables)
  functions/_shared/openrouter.ts  OpenRouter client (orComplete/orStream + tool/web helpers + usage) shared by all 3 loops + guardrails
  functions/_shared/usage.ts   recordUsage: writes a usage_events row per model call (all 3 loops + guardrails)
  functions/openrouter-balance/index.ts  Admin-only (verify_jwt: true): proxies OpenRouter GET /api/v1/key for the /usage page
  functions/_shared/builtins.ts  runBuiltin: search_documents, send_email, check_email (shared by all 3 loops)
  functions/chat/index.ts      Deno edge function: agentic tool loop, streams the model via OpenRouter (verify_jwt: true)
  functions/webhook/index.ts   Public ingest function (verify_jwt: false), runs a prompt
  functions/email-inbound/index.ts  Public inbound-email sink (verify_jwt: false), token-gated → inbox_messages
  functions/mcp/index.ts       Public MCP server (verify_jwt: false) for an external Claude
  functions/p/index.ts         Public standalone-page server (verify_jwt: false): serves a shared HTML artifact as raw text/html
railway.json, DEPLOY.md        Deployment config + guide
```

## Database & security model

Schema lives in `supabase/migrations/` (0001 base + later migrations). Tables:
`profiles`, `conversations`, `messages`, `artifacts`, `files`, `skills`,
`allowed_emails`, `webhooks`, `webhook_events`, `tools`, `activity_log`, `agents`,
`mcp_tokens`, `model_profiles`, `guardrails`, `integrations` (Vault-backed email
config), `inbox_messages`, `plugins` (installed-plugin registry), `usage_events`
(per-call token/cost accounting), `user_tables` (registry for the Tables feature;
the actual user tables are real `ut_*` tables created at runtime). Enums: `visibility`
(`private`/`unlisted`/`public`), `message_role`, `artifact_type`.

**RLS is the security boundary — never weaken it:**
- Owner-only tables (`conversations`, `messages`, `files`, `profiles`) use
  `owner_id = auth.uid()` (profiles use `id = auth.uid()`).
- `artifacts` are readable by the owner **or** when `visibility <> 'private'` — that's
  how anonymous `/share/a/:slug` works.
- Storage `files` bucket is private; policies scope objects to `(storage.foldername(name))[1] = auth.uid()::text`.
- A trigger (`handle_new_user`) auto-creates a `profiles` row on signup. Trigger
  functions have `EXECUTE` revoked from API roles and pinned `search_path`.
- `messages` and `conversations` are in the `supabase_realtime` publication.
- **Invite-only:** `profiles.is_admin` (first signup = admin). A BEFORE INSERT guard
  on `auth.users` (`enforce_invite_only`) rejects signups unless it's the first user
  or the email is in `allowed_emails` (admin-managed; RLS gated to admins). Admins
  manage invites in Settings → Invite people.

If you change the schema: update the migration, apply it, run `npm run gen:types`
(or hand-edit `database.types.ts` to match), and re-check Supabase security advisors.

## The chat edge function

`supabase/functions/chat/index.ts` (Deno). Calls **OpenRouter** (OpenAI-compatible
`/chat/completions`) through the shared `supabase/functions/_shared/openrouter.ts`
client — a thin fetch wrapper (`orComplete` non-streaming, `orStream` streaming)
that also carries the `reasoning` (effort) and `plugins` (web) fields. **Model
selection — never hardcode a model id:** the model resolves through the
`model_profiles` table via `resolveModel(db, key)`
(`supabase/functions/_shared/models.ts`). Features bind to a profile **key**, not
a model — `orchestrator` (the main brain: chat/agents/webhook/scheduled runs,
seeded `anthropic/claude-sonnet-4.5`) and `utility` (cheap + fast, seeded
`anthropic/claude-haiku-4.5`). Model ids are **OpenRouter slugs**. Admins re-point a
key in Settings → Models; the DB row is the source of truth and `OPENROUTER_MODEL`
is only a fallback when the row can't be loaded. Deployed with `verify_jwt: true`.
Reads `OPENROUTER_API_KEY` (required) and optional `OPENROUTER_MODEL`,
`OPENROUTER_EFFORT`, `OPENROUTER_SITE_URL`, `OPENROUTER_APP_NAME` from edge-function
secrets. It assembles the system prompt by reading the always-on prompts
(`skills.auto_apply = true`) with the service-role key, then optionally
appends/replaces with an invoked skill's instructions (`body.system` +
`body.replaceSystem`); the system prompt is sent as the first `{role:'system'}`
message. Request body: `{ messages, system?, replaceSystem? }`. It also loads active
`tools` rows and runs an **agentic loop**: the OpenRouter web plugin (for `kind = 'web'`)
and custom `http` tools (POST inputs to `config.url`, feed the response back). It
appends each assistant turn (content + `tool_calls`) before sending one
`{role:'tool', tool_call_id}` message per call, then loops to `MAX_TOOL_TURNS`.

**OpenRouter conventions (do not change without reason):** model ids are OpenRouter
slugs (`provider/model`, e.g. `anthropic/claude-sonnet-4.5`); reasoning effort goes
through `reasoning:{effort}` (no Anthropic `thinking`/`output_config`); tool calls
use OpenAI function-calling shape (`tool_calls` + `{role:'tool'}` results); stream
responses. Don't silently downgrade the model to save cost — that's the maintainer's
call (it's a one-line edit in Settings → Models).

## Environment & secrets

| Scope | Var | Notes |
| --- | --- | --- |
| Frontend (build-time) | `VITE_SUPABASE_URL` | Inlined into the bundle |
| Frontend (build-time) | `VITE_SUPABASE_ANON_KEY` | Public by design; RLS protects data |
| Edge secret | `OPENROUTER_API_KEY` | `supabase secrets set ...` — never commit |
| Edge secret | `OPENROUTER_MODEL` / `OPENROUTER_EFFORT` | Optional overrides (slug fallback / effort) |
| Edge secret | `OPENROUTER_SITE_URL` / `OPENROUTER_APP_NAME` | Optional OpenRouter ranking headers |

`VITE_*` are read at **build time** — they must exist before `npm run build`.

## Gotchas

- **Don't put secrets in the frontend.** Only the anon key belongs there; the OpenRouter
  key is an edge-function secret.
- **Streaming format:** the function emits SSE `data: {"delta": "..."}`; `streamChat`
  parses on `\n\n` boundaries and stops at `[DONE]`. Keep both sides in sync.
- **Realtime de-dupe:** ChatPage tracks seen message IDs so an optimistic insert and the
  realtime echo don't double-render.
- **Auth redirects:** confirmation/magic-link emails use the Supabase project **Site URL**
  + Redirect URLs allowlist. Set these to the deployed origin or links go to localhost.
- **Mobile:** layout is responsive — sidebar is a slide-in drawer, the artifact editor
  stacks vertically. Don't reintroduce fixed side-by-side panels without `md:` guards.
- **Fresh project storage race:** on a brand-new Supabase project the `storage` schema
  may lag a few seconds; if applying the full migration fails on `storage.buckets`, apply
  the core tables first, then the storage section.

## Workflow

Trunk-based: commit and push directly to `main` (no PR flow). Run `npm run build` first.
Hosting auto-deploys from `main`.
