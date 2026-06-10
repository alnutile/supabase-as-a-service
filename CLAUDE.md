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
- **Activity:** `ActivityPage` is a live feed of `activity_log`. Rows are written by
  DB triggers (`webhook_events`, `artifacts`, `files`) and by the chat function (tool
  calls). RLS: you see your own rows, admins see all. Realtime-subscribed.
- **Webhooks:** `WebhooksPage` (master–detail) creates `webhooks` rows, each with an
  opaque `token` and an attached `prompt`. External systems POST to the **public**
  `webhook` edge function at `/functions/v1/webhook/‹token›` (`verify_jwt: false`); it
  resolves the webhook by token (service role), runs the prompt against the payload via
  Claude, and logs a `webhook_events` row (`received` → `ok`/`error`) with the result.
  The page subscribes to `webhook_events` over Realtime for a live log. Routing the
  result somewhere (artifact/chat/outbound) is a later step.
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
  instead of the bare prompt.
- **MCP server:** `supabase/functions/mcp/index.ts` is a JSON-RPC-over-HTTP MCP
  server (`verify_jwt: false`) an **external** Claude (Claude Code / Desktop) connects
  to. Auth is a per-user `mcp_tokens` token (Settings → Connect Claude); every action
  runs as the token's owner. It exposes build tools (`create_agent`, `create_http_tool`,
  `create_skill`, `create_webhook`, `create_artifact`, `list_*`) so an outside Claude can
  push agents/tools into the workspace, where they appear in the dashboard.

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
  migrations/                  0001 base; 0003 invite-only; 0004 prompts; 0005 webhooks; 0006 tools; 0007 activity/attachments; 0008 agents/MCP
  functions/chat/index.ts      Deno edge function: agentic tool loop, streams Claude (verify_jwt: true)
  functions/webhook/index.ts   Public ingest function (verify_jwt: false), runs a prompt
  functions/mcp/index.ts       Public MCP server (verify_jwt: false) for an external Claude
railway.json, DEPLOY.md        Deployment config + guide
```

## Database & security model

Schema lives in `supabase/migrations/` (0001 base + later migrations). Tables:
`profiles`, `conversations`, `messages`, `artifacts`, `files`, `skills`,
`allowed_emails`, `webhooks`, `webhook_events`, `tools`, `activity_log`, `agents`,
`mcp_tokens`. Enums: `visibility`
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
(`npm:@anthropic-ai/sdk`). Model defaults to **`claude-opus-4-8`** with
`thinking: { type: 'adaptive' }` and `output_config: { effort }`. Deployed with
`verify_jwt: true`. Reads `ANTHROPIC_API_KEY` (required), `ANTHROPIC_MODEL`,
`ANTHROPIC_EFFORT` from edge-function secrets. It assembles the system prompt by
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
