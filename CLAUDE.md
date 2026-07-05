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
npm test               # vitest (frontend unit tests: src/**/*.test.ts(x))
npm run test:deno      # deno test supabase/functions/tests/ (edge-function units)
npm run gen:types      # regenerate src/lib/database.types.ts from the linked project
npm run start          # serve dist/ with SPA fallback (production / Railway)
```

Always run `npm run build` before committing UI/logic changes — it typechecks the whole app.
Run `npm test` (and `npm run test:deno` if you touched `supabase/functions/`) too; add tests
when you add or change logic (parsing, validation, calculations). Testable logic is kept out
of components/handlers on purpose — the `:::artifact` protocol parser lives in
`src/lib/artifacts.ts` (not ChatPage), webhook payload validation in
`supabase/functions/_shared/validate.ts`, the `p` page's HTML/state injection in
`supabase/functions/p/meta.ts` — follow that pattern: extract pure logic, test the module.
CI (`.github/workflows/test.yml`) runs lint + build + both suites on PRs and pushes to main;
`claude-feature.yml` runs the same checks against the bot-built branch (its PRs can't trigger
PR workflows — GITHUB_TOKEN anti-recursion).

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
  **Group chat (humans first, AI on @ai):** a thread can be shared with other workspace
  members — the "People" button on an open conversation adds them via
  `conversation_members` (migration 0053). Access = owner OR member, enforced by RLS
  through the `security definer` helper `can_access_conversation()` (avoids policy
  recursion); members read the whole thread and post **as themselves**
  (`owner_id = auth.uid()` is enforced on insert, so the sender can't be spoofed), and
  only the owner deletes the thread. In a shared thread ("Team thread" badge) humans talk
  to each other over the existing Realtime channel and **the AI only replies when a
  message contains `@ai`** — the gating is in `ChatPage.submit()` (a plain message just
  inserts + touches the conversation; no model call, so no cost). When summoned, each
  human message in the model history is prefixed with the sender's name (from the
  `list_workspace_members()` security-definer directory RPC — profiles RLS stays
  owner-only) plus a system note explaining the group context. Other people's bubbles
  render left/neutral with a name label; yours stay right/purple. Solo threads keep the
  classic always-reply behavior.
- **Artifacts:** `ArtifactsPage` (list/create) and `ArtifactEditorPage` (edit, preview,
  set visibility, delete). Public/unlisted artifacts are read anonymously by slug in
  `PublicArtifactPage` at route `/share/a/:slug`.
  **Standalone hosting:** an `html` artifact can also be viewed as a clean, chrome-free
  full-viewport page at the app's own public **`/p/:slug` route** (`StandaloneArtifactPage`)
  — for sharing "a great diagram in HTML" with the public without deploying a whole app.
  It renders inside `ArtifactFrame`'s opaque-origin sandbox (user HTML never runs raw on
  the app origin, where visitors hold a session). The editor's Sharing panel and
  `PublicArtifactPage` link to it (`standalonePageUrl(slug)` in `src/lib/supabase.ts`).
  There is also a **public `p` edge function** (`verify_jwt: false`,
  `GET /functions/v1/p/‹slug›`) that returns the artifact's raw `content` as `text/html`
  (injecting `<title>`/OpenGraph tags + a permissive CSP + `nosniff`; anon-key query so RLS
  hides private rows; only `type='html'` renders, anything else 404s) — **but Supabase
  rewrites `text/html` → `text/plain` (+ a sandbox CSP) on `*.supabase.co` function URLs**
  (anti-phishing), so browsers show raw source there. The function only truly renders behind
  a Pro-plan custom functions domain, which is why the UI links to `/p/:slug` instead.
  Because both serve straight from `artifacts.content`, editing the artifact updates the
  page live; an external/local AI app can also push HTML up (via MCP) to the same table and
  get the same URL. *(Planned: multi-file/bundled SPAs behind the
  same `p/‹slug›` URL via a public storage bucket; an MCP `publish_html` one-call helper.)*
  **Interactive artifacts (live trackers, migration 0054):** an `html` artifact can be a
  Claude.ai-style stateful mini-app (tracker/kanban/checklist) — the user clicks and the
  changes persist. The sandboxed iframe (`allow-scripts`, opaque origin — deliberately no
  localStorage/session access) talks a tiny postMessage protocol implemented by
  `src/components/ArtifactFrame.tsx`: iframe posts `artifact:ready` → parent replies
  `artifact:state` with the saved `artifacts.data` jsonb; iframe posts `artifact:save` on
  each user change → the PARENT (authed client, normal RLS) persists it debounced. The
  artifact HTML never sees credentials. `ArtifactFrame` is used by the editor preview, the
  public share page (saves are RLS no-ops for non-owners), and **ChatPage's live artifact
  panel**: creating an artifact in chat (or clicking an artifact link in an assistant
  message) opens it beside the thread; the panel follows the row over Realtime
  (`artifacts` joined the `supabase_realtime` publication in 0054), so assistant edits
  render live. The `p` standalone page injects the saved state as
  `window.__ARTIFACT_DATA__` (read-only render for anon visitors). Seeded `is_builtin`
  tools `get_artifact` / `update_artifact` (handlers in `_shared/builtins.ts`; update is
  owner-only, logs `artifact.updated`) let the assistant read the current version and
  evolve it in place instead of duplicating; a seeded always-on "Interactive artifacts"
  prompt (its own `auto_apply` skill row) teaches the bridge snippet + the
  get-then-update revision flow. The editor's **Chat** button deep-links
  `/chat?artifact=:id`: the artifact opens in the live panel and, whenever the panel is
  open, `ChatPage.submit()` appends a system note naming it — so "update it / check off X"
  resolves to get_artifact→update_artifact on THAT artifact instead of minting a new one.
  Both side panels (chat + editor preview) are drag-resizable on md+ via
  `src/components/ResizeHandle.tsx` (`usePanelResize`: pointer-captured drag on the left
  edge — capture keeps the drag alive over the iframe — width persisted per-panel in
  localStorage, exposed as a `--panel-w` CSS var consumed only at `md:`).
  **REST CRUD API (`artifacts` edge function, `verify_jwt: false`):** a plain‑REST API so
  non‑Claude systems (scripts, Zaps, cron) can push/sync artifacts with a `curl` instead of
  MCP. Auth is a per‑user **bearer token** — the same `mcp_tokens` from Settings → Connect
  Claude; the function runs as the token's owner (service role) and re‑enforces ownership in
  code. `GET/POST /functions/v1/artifacts`, `GET/PATCH/PUT/DELETE /functions/v1/artifacts/:id`;
  create/update accept `collection`/`collections` (name or id, created if missing) to **tag**
  artifacts into collections (additive), plus `visibility` (non‑private mints a `public_slug`
  + `share_url`). A bare `GET` with no `Authorization` (or `/artifacts/docs`) returns
  plain‑text docs. Full reference: `docs/artifacts-api.md`. **In‑app docs:** `ApiPage`
  (route `/api`, sidebar "API") is a tabbed area (first tab Artifacts; more later) that
  renders the base URL, endpoints, body reference, and copy‑ready `curl` examples — and
  lets you pick/create a bearer token (`mcp_tokens`) so the examples are paste‑ready.
- **Collections (tag artifacts → chat with a focused set):** a `collections` row is a
  named group ("tag") of artifacts; `collection_artifacts` is the many-to-many join
  (migration 0033). On `ArtifactsPage` you multi-select artifacts (checkboxes) and file
  them into one or more collections via the floating "Add to collection" bar (creating a
  collection inline), and a filter bar scopes the grid to one collection. In **Chat** the
  📚 picker selects **one or more** collections (multi-select; "Chat with this" deep-links
  `/chat?collection=:id`, or `?collections=a,b`); `streamChat({ collectionIds })` passes them
  to the chat function, which `loadCollectionsContext` gathers the **deduped** union of their
  **multi-content** items and injects them as a primary-context block in the system prompt:
  artifacts (text), files (`collection_files`, migration 0042 — text files inlined, PDFs via
  their indexed knowledge chunks, via `fileToText`; images/binaries skipped), to-dos, and
  **tables** (`collection_tables`, migration 0045 — a preview of the `ut_*` rows as JSON).
  The shared `AddToCollectionBar` component drives "select items → Add to collection" on the
  Artifacts and Files pages; `_file_chars` folds files into the size meter RPCs. **`CollectionsPage`
  (route `/collections`, Assets) is a per-collection dashboard**: a card per content type
  (to-dos/artifacts/files/tables) with add/remove, the context-window meter, and a floating
  chat bubble (`streamChat({ collectionIds:[id] })`) that answers about the collection and files
  new to-dos/notes/artifacts back into it via the builtin authoring tools.
  Access mirrors `user_tables`: a collection is `private` (owner + admins) or `workspace`
  (every member can read **and** collaborate — add/remove members); the join table's RLS
  inherits the collection's visibility. The chat function runs as the service role so it
  **re-enforces** access in code (collection visible to caller; only own/non-private
  artifacts injected). Collections are also an **ingestion target**: MCP exposes
  `create_collection` / `add_to_collection` / `list_collections` and `create_artifact` takes
  an optional `collection` (name, created if missing), so an external Claude can push blog
  posts / video transcripts / notes from other systems into a named collection the team can
  chat with. The **internal** assistant has the same authoring power as `is_builtin` tools
  (`create_artifact` / `create_collection` / `add_to_collection` / `list_collections` / `add_note`
  in `_shared/builtins.ts`, migration 0040), so chat + scheduled/webhook agents can ingest content
  into artifacts + collections + the knowledge base too (e.g. an agent that files fetched articles
  into a collection on a schedule or a GitHub webhook). **Context-window awareness:** each collection shows an estimated token count
  (≈chars/4 — there's no single correct tokenizer) and, via `useOrchestratorContext` →
  the live OpenRouter model's `context_length` (fetched from `/api/v1/models`), what % of
  that window it would fill (`ContextMeter` on the Artifacts collection header + filter chips;
  `ContextUsage` in the chat picker rows + active chips), so the user can judge fit and pick a
  different model if needed. When several collections are scoped together, the chat picker shows
  the **combined, deduped** size (the `collections_combined_chars(uuid[])` RPC, migration 0035)
  so overlapping artifacts aren't double-counted. Single-collection sizes come from the RLS-aware
  `collection_token_stats()` RPC (migration 0034, `security invoker`) on Chat, and a client-side
  memo on the Artifacts page (which already holds the content). The chat function budgets the total
  injected content to the model's real window minus a reserve for the conversation + reply (so the
  meter matches what's sent).
  *(Planned: collection-scoped retrieval/RAG + hybrid search as a core function instead of
  full-content injection; collection visibility on the public share pages.)*
- **To-dos:** `TodosPage` (route `/todos`, sidebar under **Assets**, any member) is a
  simple task list that plugs into the collections concept. A `todos` row (migration 0041)
  is `title` + optional `notes` + optional `due_date` + a `done` flag + a `position` for
  manual **drag-to-reorder** (dnd-kit; order by `position asc, created_at desc`, with a
  "Due date" sort toggle). Visibility mirrors collections/`user_tables`: `private` (owner +
  admins) or `workspace` (every member can see **and** collaborate — check off / edit /
  reorder), enforced by RLS. To-dos are filed into collections via `collection_todos` (the
  exact mirror of `collection_artifacts`, same visibility-inherited RLS), so the same
  multi-select "Add to collection" bar + filter as `ArtifactsPage`, and a collection you
  chat with carries its tasks alongside its docs (the chat function's
  `loadCollectionsContext` injects each collection's to-dos as a checklist block). Like
  artifacts, to-dos have a **REST API** (`todos` edge function, `verify_jwt:false`,
  bearer-token `mcp_tokens`, full CRUD + `collection`/`collections` tagging; docs at
  `docs/todos-api.md` and the "To-dos" tab in `ApiPage`) and are exposed to the assistant +
  MCP: seeded `is_builtin` tools `create_todo` / `list_todos` / `complete_todo` /
  `update_todo` / `add_todo_to_collection` (in `_shared/builtins.ts`; same names on the MCP
  server) so chat/scheduler/webhook agents and an external Claude can manage tasks.
- **Links (shared bookmarks):** `LinksPage` (route `/links`, sidebar under **Assets**,
  any member) is a bookmarks area that plugs into the collections concept. Paste a URL and
  the metadata fills in automatically: the page inserts the row immediately (hostname as
  placeholder title), then the **`link-meta` edge function** (`verify_jwt: true`, any member)
  fetches the page server-side (browser can't cross-origin) and the row is patched with the
  parsed `<title>`/OpenGraph title, meta/og description, `og:image` preview and favicon —
  parsing lives in `_shared/linkmeta.ts` (capped read of ~512KB, 10s timeout, never throws,
  falls back to the hostname) so the `save_link` builtin fills rows identically. A `links`
  row (migration 0049) is `url` + fetched `title`/`description`/`image_url`/`favicon_url` +
  optional `notes` + **`screenshot_path`** — a captured screenshot stored in the private
  `link-screenshots` bucket (migration 0052; member-readable, owner-folder writes, service
  role for pipelines). The card prefers a signed screenshot URL over og:image. The seeded
  `set_link_screenshot` builtin attaches one from an image URL (download → bucket → path),
  so a browse-the-web capture, agent, or `run-tool` call can fill it; only the *capture*
  itself is external. Visibility mirrors todos/collections: `private` (owner + admins) or
  `workspace` (every member can see and edit), enforced by RLS. Links file into collections
  via `collection_links` (exact mirror of `collection_todos`, visibility-inherited RLS) —
  the card grid has the same select → shared `AddToCollectionBar` (kind `link`) + collection
  filter chips, `CollectionsPage` shows a Links card (create-by-pasting-a-URL included), and
  `loadCollectionsContext` injects each collection's links as a compact title/url/description
  list block so chatting with a collection carries its links. Seeded `is_builtin` tools
  `save_link` / `list_links` / `add_link_to_collection` (in `_shared/builtins.ts`) let
  chat/scheduler/webhook agents capture links (metadata auto-fetched; `link.created`
  activity-logged). *(Planned: screenshot capture via the browse-the-web tooling filling
  `screenshot_path`; a REST API + MCP tools like artifacts/to-dos.)*
- **Files:** `FilesPage` uploads to the private `files` storage bucket under
  `‹user-id›/…` and creates 7-day signed URLs for sharing.
  **AI-writable Files (CRUD):** seeded `is_builtin` tools `create_file` / `list_files` /
  `get_file` / `delete_file` / `add_file_to_collection` (shared executor in
  `_shared/files.ts`, run by all three agent loops via `runBuiltin`; the MCP server exposes
  the same names) let the assistant + an external Claude persist and manage files — most
  importantly **binary output it generates** (e.g. a base64 PNG from an image model, which
  returns b64 only, no hosted URL). `create_file` takes `content_base64` **or** `content_text`
  (+ `filename`, inferred `mime_type`, `visibility` private|workspace, `collection`, `tags`,
  `source` provenance jsonb), decodes server-side, enforces a **10 MB** cap and a MIME
  allow-list (png/jpeg/webp/gif, pdf, text/plain, text/markdown, csv, json), uploads to the
  same `files` bucket at `‹owner›/‹uuid›/‹name›`, inserts a `files` row (so it shows in the
  Files UI, obeys the owner-only RLS, and PDFs auto-index via the `enqueue_document` trigger),
  and returns a **7-day signed URL** + file id. Everything is re-scoped to the caller in code.
  `files.tags`/`files.source` columns added in migration 0055 (both nullable — the manual
  upload path is unaffected). The older MCP-only `upload_file` still works; `create_file` is
  the richer variant (text payloads, returns a URL, tags/collection/source).
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
  `update_table_row` / `create_table` (in `_shared/builtins.ts`, so chat/agents/scheduler all
  get them; `update_table_row` seeded in migration 0044) run with the service role and
  **re-enforce the private/workspace rule in code** — and `update_table_row` requires a
  `match` filter so it can't rewrite a whole table; MCP exposes `list_tables` / `create_table` /
  `add_table_row` / `update_table_row` for an external Claude. *(Planned: a
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
- **Secrets vault (Governance):** `VaultPage` (route `/vault`, sidebar "Secrets" under
  Governance, admin-only) lets admins store named secrets (API keys, tokens, passwords)
  that the team — and the assistant — can use. Same Vault-backed pattern as the email key
  and MCP tokens: the **value lives only in Supabase Vault** (`vault_secrets.secret_id`
  pointer; migration 0037), never a table column, client payload, or log. Each secret is
  `workspace` (shared with everyone) or `private` (owner + admins), mirroring collections /
  user_tables. Writes go through admin-gated security-definer RPCs (`set_vault_secret`
  upsert with write-only value — empty keeps the current one; `delete_vault_secret`); the
  decrypted value is read **only** by the service role via `read_vault_secret(name, user_id)`,
  which re-enforces the share rule in code (workspace → anyone; private → owner). Two seeded
  `is_builtin` tools in `_shared/builtins.ts` expose it to all three agent loops:
  `list_secrets` (names + descriptions, **never values**, for discovery) and `get_secret`
  (one value by name). `get_secret` returns a raw credential into the conversation, so it's
  exfiltration-capable like `send_email` — it's an ordinary `tools` row (admin activation,
  agent `tool_ids` scoping, and the `webhooks.allow_tools` gate all apply) and logs every
  read as `activity_log` type `secret.read`.
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
- **Direct tool runs (`run-tool`):** the universal tool runner closes the "tools only run
  inside the agent loops" gap. `POST /functions/v1/run-tool` with `{tool, input}` invokes any
  **active** tool with **no model in the loop** — same dispatch as the loops (`builtin` →
  `runBuiltin`, `http` → `runHttpTool` with vault refs, MCP remote tools by namespaced name
  via `runMcpTool`; `web` errors, it's a model plugin). `{steps:[{tool,input},…]}` (max 10)
  chains tools deterministically — `{{prev}}` inside any string input is replaced with the
  previous step's result text. Auth (`verify_jwt:false`, checked in code): a personal
  `mcp_tokens` bearer **or** a Supabase session JWT (verified via `auth.getUser`, never
  trusted from its payload) — so the UI, scripts, cron, and Zaps can all call it; every call
  runs AS the resolved user (builtins re-enforce private/workspace access) and logs
  `activity_log` type `tool.run`. `GET /run-tool/list` returns runnable tools + schemas;
  `GET /run-tool/docs` is plain-text docs; the "Run tools" tab in `ApiPage` renders
  copy-ready curl. No guardrail runs (nothing reaches an LLM — same reasoning as the
  webhook direct mode); activation + per-user access rules are the gate. Note the
  `http_request` builtin returns HTML responses converted to **markdown** by default
  (`_shared/html_markdown.ts`; `format:"raw"` opts out — migration 0051 documents it in the
  tool schema), so fetch→ingest chains stay inside the 50k-char result budget.
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
  (`instructions`) + `tool_ids` it may use + `collection_ids` it can **use**
  (migration 0043). `AgentsPage` is the dashboard (CRUD, workspace-visible).
  "Chat" opens `/chat?agent=:id`, where `ChatPage` layers the agent's prompt on the
  conversation and scopes the toolset to the agent's tools
  (`streamChat({ system, toolIds })` → chat function's `loadTools(restrictIds)`).
  **Collections an agent uses:** the agent's bound `collection_ids` are injected as
  primary context (artifacts/files/to-dos) whenever it runs — chat (merged with the
  user's picked collections), webhook, and scheduler all call the shared
  `_shared/collections.ts` `loadCollectionsContext` (moved out of the chat function
  so every loop shares it). Agents *add into* collections via the existing `is_builtin`
  authoring tools (`create_collection` / `add_to_collection` / `create_artifact` /
  `add_todo_to_collection` / `add_table_to_collection`), scoped by `tool_ids` like any tool.
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
  push agents/tools into the workspace, where they appear in the dashboard. It also drives
  the **looping system** (`create_loop` / `run_loop` / `get_loop_run` / `list_loops`): an
  external Claude hands a loop a goal (prompt) + rubric + budget + iteration cap, kicks off a
  run, then polls `get_loop_run` to "check in" until it's done — same machinery as the Loops
  dashboard. The shared `_shared/loops.ts` helpers (create the loop, trigger the `loop` edge
  function, format a run) back both this and the in-app builtins so they never drift; an
  internal trigger passes `triggered_by` (honored only for the service-role caller, which has
  no JWT `sub`) so the run is attributed to the right user. *(Planned — see `docs/tasks/`:
  `upload_file` + a signed-URL pair to push files/PDFs into Files and the knowledge base, and
  a tabbed Code/Desktop connect UI.)*
- **External MCP client (outbound):** the inverse of the MCP *server* above — the
  workspace connects out to **any number of external MCP endpoints** (e.g. **Zapier MCP** in
  front of Gmail/Calendar, plus others) so agents can call their tools. An admin adds servers
  in **Settings → External MCP servers**; each is a row in **`public.mcp_servers`** (label,
  url, `secret_id`→Vault, `scope`, `tool_id`, `cached_tools`; migration 0036, which replaced
  0032's single-row `integrations` model and migrated the existing row in place). Each token
  lives ONLY in Supabase Vault — the admin RPC `set_mcp_server(id,label,url,token)` writes it
  (token write-only), `delete_mcp_server(id)` removes a server, and the service-role-only
  `read_mcp_secret(server_id)` reads it. Every server gets **one `tools` row of `kind='mcp'`
  as its in-app handle** (`config.server_id`→`mcp_servers.id`): activating it (ToolsPage, "MCP"
  badge) or scoping it to an agent via `tool_ids` turns *that server's* whole remote toolset
  on/off like any other tool. `supabase/functions/_shared/mcp.ts` is the **MCP client** (JSON-RPC
  over Streamable HTTP — `initialize` handshake → optional `Mcp-Session-Id` → `tools/list`
  / `tools/call`, parsing JSON or SSE replies). `expandMcpTools()` resolves each handle to its
  server, discovers the remote tools, **expands each into a first-class namespaced function**
  (`‹label›__‹remote›`, e.g. `zapier__gmail_find_email`) and caches the list on
  `mcp_servers.cached_tools` (10-min TTL) so the loops don't re-handshake every message;
  `runMcpTool()` executes a call (per-server token); `refreshServer()` re-discovers one server.
  Wired into the three agent loops (chat, scheduler, webhook) right beside `http`/`builtin`
  dispatch, so it composes with every existing gate — admin activation, agent `tool_ids`
  scoping, the `webhooks.allow_tools` lock, and the `runGuardrails` pre-flight. The admin-only
  `mcp-admin` edge function (`verify_jwt: true`) powers Settings' "Connect & list tools" — it
  validates one server (`server_id`) server-side and refreshes its cache. The remote tools are
  exfiltration-capable (they can send mail), so they carry the same workspace-wide trust as
  `send_email`. The `mcp_servers.owner_id`/`scope` columns exist for **per-user servers
  (Phase 2, not built)** — every row is workspace-wide for now. *(Planned: per-user tokens +
  a member-facing UI, auto-refresh, and wiring the eval `orchestrator`/`loop` loops.)*
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
- **DB migrations on `main`:** a **GitHub Action** (`.github/workflows/deploy-migrations.yml`)
  runs `supabase db push` whenever a file under `supabase/migrations/**` changes on `main`, so new
  migrations go live automatically (the CLI's migration history makes re-runs apply only what's
  pending). It needs `SUPABASE_ACCESS_TOKEN` (the same PAT as the functions workflow) **plus**
  `SUPABASE_DB_PASSWORD` — `db push` connects straight to Postgres, so the access token alone can't
  apply migrations. Project ref defaults in the workflow, overridable via the `SUPABASE_PROJECT_REF`
  repo variable. **Each migration filename must have a unique, contiguous numeric prefix**
  (`0040_…` after `0039_…`): `db push` derives the version from the prefix, so two files sharing
  a number (e.g. two `0032_*.sql`) collide and the push is rejected. Always use the next free number.
- **In-app function deploys (edge functions don't ride `main` by default):** pushing to `main`
  redeploys the **frontend** (Railway), but the Supabase
  **edge functions** otherwise only update via a `functions deploy`. Two things close this gap:
  (1) a **GitHub Action** (`.github/workflows/deploy-functions.yml`) runs `supabase functions deploy`
  on pushes that touch `supabase/functions/**` or `config.toml` (needs repo secrets
  `SUPABASE_ACCESS_TOKEN` — a Supabase PAT, same kind as `FORGE_PAT` — and `SUPABASE_PROJECT_REF`;
  `verify_jwt` comes from `config.toml`); it deploys only the **core/repo** functions (forged ones
  live in the DB, not git). (2) Forge's "Deploy maintenance" panel (admin-only, on `ForgePage`)
  does the same from inside the app for when you can't push, reusing Forge's Management-API path
  (`_shared/management.ts`, now multi-file capable): **"Update core functions"** → forge
  `deploy_core` redeploys the repo functions (`chat`, `mcp`, `webhook`, `scheduler`, …) from their
  source **bundled into the UI at build time** (`src/lib/functionSources.ts` via
  `import.meta.glob('?raw')`, lazy-loaded so it never weighs down the main bundle); since the
  frontend auto-deploys from `main`, that bundled source is current as of the last deploy.
  **"Redeploy forged functions"** → `redeploy_all_forged` re-pushes every vibe-coded function's
  stored source (the only path for those — CI can't, they're not in git). `deploy_core` is
  admin-only and **slug allow-listed** (`CORE_SLUGS`) so it can only (re)deploy known functions,
  never arbitrary ones; no lint runs (core functions legitimately use `Deno.env` + the service
  role). Outcomes log as `forge.deploy_core` / `forge.redeploy_all`. Bootstrapping note: the
  `forge` function itself must be deployed once (CLI/Action/MCP) to gain these actions; after that
  it can redeploy everything, including itself.

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
                               TodosPage, FilesPage, TablesPage, SkillsPage, WebhooksPage, ToolsPage,
                               AgentsPage, PluginsPage, ApiPage, ActivityPage, SettingsPage
  lib/
    supabase.ts                createClient<Database>(...) + chatFunctionUrl
    chat.ts                    streamChat(): SSE parser for the chat function
    plugins.ts                 Static catalog of upstream Edge Function examples
    database.types.ts          Typed schema (keep in sync with the migration)
    util.ts                    makeSlug, formatBytes, formatDate
supabase/
  migrations/                  0001 base … 0008 agents/MCP; 0012 PDF knowledge; 0014 model profiles; 0015 guardrails; 0016 email/Vault; 0018 plugins registry; 0019 OpenRouter provider; 0020 usage tracking; 0029 user tables (Airtable-like real Postgres tables); 0033 collections (tag/group artifacts to chat with); 0034 collection_token_stats RPC (per-collection size for the context-window meter); 0035 collections_combined_chars RPC (deduped size of several collections); 0036 mcp_servers (external MCP endpoints, Vault tokens); 0037 vault_secrets (Vault-backed team secrets vault); 0038 loop_builtins (start_loop/check_loop/list_loops); 0039 loop_stop_reason_time ('time' stop reason); 0040 authoring_builtins (create_artifact/create_collection/add_to_collection/list_collections/add_note); 0041 todos (+ collection_todos join; seeds to-do builtins); 0042 collection_files (files in collections + _file_chars sizing); 0055 files_builtins (files.tags/source columns + seeds the file CRUD builtins create_file/list_files/get_file/delete_file/add_file_to_collection)
  functions/_shared/openrouter.ts  OpenRouter client (orComplete/orStream + tool/web helpers + usage) shared by all 3 loops + guardrails
  functions/_shared/usage.ts   recordUsage: writes a usage_events row per model call (all 3 loops + guardrails)
  functions/openrouter-balance/index.ts  Admin-only (verify_jwt: true): proxies OpenRouter GET /api/v1/key for the /usage page
  functions/_shared/builtins.ts  runBuiltin: search_documents, send_email, check_email, tables/vault tools, + loop tools (start_loop/check_loop/list_loops) — shared by all 3 loops
  functions/_shared/loops.ts   create/trigger/format helpers for the looping system, shared by the MCP server + builtins
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
the actual user tables are real `ut_*` tables created at runtime), `collections` +
`collection_artifacts` (named groups of artifacts you can scope a chat to), `mcp_servers`
(external MCP endpoints), `vault_secrets` (Vault-backed team secrets vault). Enums: `visibility`
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
