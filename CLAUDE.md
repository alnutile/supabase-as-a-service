# CLAUDE.md

Guidance for AI agents (and humans) working in this repository.

## What this is

A React intranet layer on top of Supabase: auth, an AI chat assistant, shareable
"artifacts" (docs/code/HTML), file storage, and live realtime updates. The
Anthropic key is server-side only (a Supabase Edge Function); the browser holds
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
  The function calls Anthropic; the client only sends the message history + the user's
  access token (+ the anon key as the `apikey` header).
- **Artifacts:** `ArtifactsPage` (list/create) and `ArtifactEditorPage` (edit, preview,
  set visibility, delete). Public/unlisted artifacts are read anonymously by slug in
  `PublicArtifactPage` at route `/share/a/:slug`.
- **Files:** `FilesPage` uploads to the private `files` storage bucket under
  `‹user-id›/…` and creates 7-day signed URLs for sharing.
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
- **Prompts & skills:** one `skills` table, two modes.
  - `auto_apply = true` → **always-on** prompts (admin-managed, workspace-wide). The
    seeded `is_builtin` "How this workspace works" prompt teaches the assistant the
    system + the artifact protocol. The chat edge function loads all `auto_apply`
    rows (via service role) and concatenates them into the system prompt on every call.
  - `auto_apply = false` → **on-demand** skills (personal). In `ChatPage`, typing `/`
    (or the ⚡ button) lists them; `runSkill()` sends them as the `system` (artifact
    mode uses `replaceSystem: true` for clean output; reply mode appends to context).
- **Tools (tools-as-data):** the `tools` table defines capabilities the chat loop
  exposes to Claude. `kind = 'http'` → a custom tool; Claude calls it and the chat
  function POSTs the inputs to `config.url` and feeds the response back. `kind = 'web'`
  → switches on Anthropic's server-side `web_search`/`web_fetch`. Admin-managed
  (`ToolsPage`); a seeded `is_builtin` "web_browsing" row is on by default. The chat
  function runs an **agentic loop** (model → tool_use → execute → tool_result → … →
  end_turn), preserving thinking + tool_use blocks across turns (the opus-4-8 rule).
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
                               FilesPage, SkillsPage, WebhooksPage, ToolsPage,
                               AgentsPage, ActivityPage, SettingsPage
  lib/
    supabase.ts                createClient<Database>(...) + chatFunctionUrl
    chat.ts                    streamChat(): SSE parser for the chat function
    database.types.ts          Typed schema (keep in sync with the migration)
    util.ts                    makeSlug, formatBytes, formatDate
supabase/
  migrations/                  0001 base … 0008 agents/MCP; 0012 PDF knowledge; 0014 model profiles; 0015 guardrails; 0016 email/Vault
  functions/_shared/builtins.ts  runBuiltin: search_documents, send_email, check_email (shared by all 3 loops)
  functions/chat/index.ts      Deno edge function: agentic tool loop, streams Claude (verify_jwt: true)
  functions/webhook/index.ts   Public ingest function (verify_jwt: false), runs a prompt
  functions/email-inbound/index.ts  Public inbound-email sink (verify_jwt: false), token-gated → inbox_messages
  functions/mcp/index.ts       Public MCP server (verify_jwt: false) for an external Claude
railway.json, DEPLOY.md        Deployment config + guide
```

## Database & security model

Schema lives in `supabase/migrations/` (0001 base + later migrations). Tables:
`profiles`, `conversations`, `messages`, `artifacts`, `files`, `skills`,
`allowed_emails`, `webhooks`, `webhook_events`, `tools`, `activity_log`, `agents`,
`mcp_tokens`, `model_profiles`, `guardrails`, `integrations` (Vault-backed email
config), `inbox_messages`. Enums: `visibility`
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

`supabase/functions/chat/index.ts` (Deno). Uses the official Anthropic SDK
(`npm:@anthropic-ai/sdk`) with `thinking: { type: 'adaptive' }` and
`output_config: { effort }`. **Model selection — never hardcode a model id:**
the model resolves through the `model_profiles` table via `resolveModel(db, key)`
(`supabase/functions/_shared/models.ts`). Features bind to a profile **key**, not
a model — `orchestrator` (the main brain: chat/agents/webhook/scheduled runs,
seeded `claude-opus-4-8`) and `utility` (cheap + fast, seeded
`claude-haiku-4-5-20251001`). Admins re-point a key in Settings → Models; the DB
row is the source of truth and `ANTHROPIC_MODEL` is only a fallback when the row
can't be loaded. Deployed with `verify_jwt: true`. Reads `ANTHROPIC_API_KEY`
(required), `ANTHROPIC_MODEL`, `ANTHROPIC_EFFORT` from edge-function secrets. It assembles the system prompt by
reading the always-on prompts (`skills.auto_apply = true`) with the service-role key,
then optionally appends/replaces with an invoked skill's instructions
(`body.system` + `body.replaceSystem`). Request body: `{ messages, system?, replaceSystem? }`.
It also loads active `tools` rows and runs an **agentic loop**: server-side
`web_search`/`web_fetch` (for `kind = 'web'`) and custom `http` tools (POST inputs to
`config.url`, feed the response back). It appends each assistant turn's full `content`
(thinking + tool_use blocks) before sending `tool_result`s, then loops to `MAX_TOOL_TURNS`.

**Anthropic conventions (do not change without reason):** default to `claude-opus-4-8`;
use **adaptive thinking** (`budget_tokens`, `temperature`, `top_p` are removed on Opus
4.8 and will 400); stream responses. Don't downgrade the model to save cost — that's
the maintainer's call.

## Environment & secrets

| Scope | Var | Notes |
| --- | --- | --- |
| Frontend (build-time) | `VITE_SUPABASE_URL` | Inlined into the bundle |
| Frontend (build-time) | `VITE_SUPABASE_ANON_KEY` | Public by design; RLS protects data |
| Edge secret | `ANTHROPIC_API_KEY` | `supabase secrets set ...` — never commit |
| Edge secret | `ANTHROPIC_MODEL` / `ANTHROPIC_EFFORT` | Optional overrides |

`VITE_*` are read at **build time** — they must exist before `npm run build`.

## Gotchas

- **Don't put secrets in the frontend.** Only the anon key belongs there; the Anthropic
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
