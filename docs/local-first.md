# Local-first second brain

Where this branch is headed: a single-user desktop app (Tauri, macOS first) that
keeps everything in SQLite and plain folders on disk, with no Supabase stack to
run. It is a second brain for AI to read and write, and later a harness. The
hosted Supabase build keeps working as-is from the same codebase.

## What stays, what went

Phase 1 (this branch) removed these from both builds. The UI, edge functions,
MCP tools and builtins are gone. The database tables are left in place
(migration `0132` only unschedules cron jobs and deactivates builtin rows), so
nothing is lost on hosted.

| Area | Status | Notes |
|---|---|---|
| Inbox (email, Slack, message ingest) | Removed | Email + Slack settings went with it |
| Knowledge (compiler) | Removed | Collections no longer inject compiled pages |
| Agents, agent jobs | Removed | Coming back later as part of the harness |
| Listeners / Events | Removed | Table "emit events" toggle removed too |
| Loops | Removed | |
| Tools page, Forge, run-tool | Removed | Chat keeps its builtins plus external MCP tools |
| Webhooks | Removed | |
| API page + artifacts/todos REST | Removed | MCP is the way in from outside |
| Feedback page | Removed | Thumbs up/down in chat still records rows |
| Features board | Removed | Security "promote to feature" removed |
| Dropbox | Removed | |
| Invite people / join links | Removed | Signup is still invite-only on hosted, so add emails in SQL for now. Federation later |
| Chat | Kept | |
| Files | Kept | Becomes watched folders + an uploads folder locally |
| Tables | Kept | |
| Meeting notes | Kept | |
| Terminology | Kept | |
| Secrets (vault) | Kept | |
| MCP (server + external servers) | Kept | |

Not discussed yet, still in the app: Collections, Artifacts, To-dos, Links,
Whiteboards, Cards, Memory, Skills, Activity, Usage, Guardrails, Security,
Evals, Home dashboard widgets. See Open questions.

## Target architecture (local build)

```
┌──────────────── Tauri app (.app / .dmg) ────────────────┐
│  WebView: existing React/Vite UI (src/)                 │
│     │  data layer: src/lib/data/*  (local backend)      │
│     ▼  HTTP + SSE on 127.0.0.1                          │
│  Sidecar "brain" (Bun-compiled single binary, TS)       │
│     • SQLite (bun:sqlite) + FTS5 + sqlite-vec           │
│     • chat orchestrator + builtins (ported from         │
│       supabase/functions/_shared)                       │
│     • MCP server: HTTP for the app, stdio for           │
│       Claude Desktop / Claude Code                      │
│     • folder watcher + indexer                          │
│     • model router: OpenRouter or any OpenAI-compatible │
│       endpoint (Ollama, LM Studio)                      │
│  Rust shell: window, sidecar lifecycle, Keychain,       │
│     folder picker                                       │
└─────────────────────────────────────────────────────────┘
Data: ~/Library/Application Support/<app>/brain.db
Files: user-chosen watched folders + <app support>/uploads/
```

Why a TypeScript sidecar rather than doing it all in Rust or straight from the
WebView:

- Most of the brains already live in TypeScript: the chat loop, builtins,
  retrieval and MCP server in `supabase/functions/_shared`. They are
  Deno-flavoured but port to Bun with small shims (`Deno.env` and `npm:`
  imports). Rewriting them in Rust is a lot of work for no user-visible gain.
- One process owns the database. The UI, the MCP server and the folder watcher
  all go through it, so there are no write races.
- MCP has to be reachable while the window is closed. The same binary runs
  as `brain mcp --stdio`, so Claude Desktop and Claude Code can use the second
  brain directly.
- Rust stays thin: it starts and stops the sidecar, holds secrets in the
  macOS Keychain, and handles native dialogs.

## Mapping Supabase pieces to local

| Supabase today | Local |
|---|---|
| Postgres tables + RLS | SQLite, single user, no RLS. `owner_id` and `visibility` columns dropped from the local schema |
| Auth (email/password, anon) | None locally. App lock via macOS login, optional Touch ID later |
| `supabase.from()` (144 call sites, 44 tables) | `src/lib/data/*` repository modules with a `supabase` and a `local` implementation |
| RPCs (24 calls) | Sidecar endpoints, or plain SQL in the repo layer |
| Realtime `postgres_changes` (21 subscriptions) | Sidecar SSE stream: `{table, op, row}` events |
| Storage buckets | Files on disk. Uploads go to `<app support>/uploads/`; watched folders stay where they are |
| pgvector + tsvector hybrid search | `sqlite-vec` + FTS5, same reciprocal-rank fusion as `0087_hybrid_search_single_rpc` |
| Edge functions | Sidecar routes (chat, transcribe, link-meta, mcp, evals) |
| pg_cron ingest tick | Sidecar background queue triggered by file events |
| Vault (secrets) | Values in macOS Keychain, names and allowed hosts in SQLite |
| User tables (physical PG tables via `create_user_table`) | One `user_table_rows(table_id, id, data JSON)` table queried with `json_extract`. No runtime DDL |
| OpenRouter key server-side | Keychain. Model router also accepts a local base URL |

## Files: folders the system watches

- **Watched folders:** the user adds folders (for example `~/Notes`,
  `~/Documents/Clients`). The sidecar watches them (FSEvents through
  `@parcel/watcher` or Rust `notify`), and on add or change extracts text from
  md, txt, pdf, docx and html. It chunks and embeds that text into
  `file_chunks`. Deletes remove the chunks. The files themselves are never
  moved or copied.
- **Uploads:** drag-and-drop or chat attachments are copied into
  `<app support>/uploads/` and indexed the same way.
- `files` rows store `source` (`watched` | `upload`), absolute `path`, `mtime`,
  `sha256` (to skip re-indexing unchanged files) and `index_status`.

## Initial SQLite schema (sketch)

```sql
-- chat
conversations(id, title, created_at, updated_at)
messages(id, conversation_id, role, content, attachments JSON, created_at)

-- files + retrieval
watched_folders(id, path UNIQUE, enabled, added_at)
files(id, source, path, name, mime, size, mtime, sha256, index_status, created_at)
file_chunks(id, file_id, ord, text)            -- + FTS5 virtual table
file_chunk_vec USING vec0(embedding float[N])  -- sqlite-vec, rowid = file_chunks.id

-- tables
user_tables(id, name, description, columns JSON, created_at, updated_at)
user_table_rows(id, table_id, data JSON, created_at, updated_at)

-- meeting notes
meetings(id, title, started_at, audio_path, transcript, notes, summary JSON, status)

-- terminology
terminology(id, term, definition, aliases JSON, created_at, updated_at)

-- secrets (values live in Keychain under service "<app>", account = name)
secrets(name PRIMARY KEY, description, allowed_hosts JSON, created_at)

-- MCP
mcp_servers(id, label, url_or_command, transport, enabled, cached_tools JSON)

-- settings
settings(key PRIMARY KEY, value JSON)   -- model profiles, base URLs, timezone
```

Collections, artifacts, todos, links, skills, memory and the rest get added
once the open questions below are settled. Their Postgres shapes port over
almost 1:1.

## Phases

1. **Remove features (this branch).** Done: UI, edge functions, MCP tools and
   builtins trimmed. The hosted build still works.
2. **Data-access seam.** Move every `supabase.from()`, `.rpc()`, `.channel()`
   and `.storage` call in `src/` behind `src/lib/data/<domain>.ts` functions,
   one domain per PR (chat, files, tables, meetings, terminology, secrets,
   mcp, ...). Hosted behaviour stays identical, and each step can be checked
   with `npm run build` + `npm test` + the smoke test. This is the step that
   makes the local backend possible without a big-bang rewrite.
3. **Sidecar + SQLite.** New `local/` package: Bun app, SQLite schema +
   migrations, ports of `_shared/{builtins,retrieval,collections,mcp,
   orchestrator}` and `chat/index.ts`. Add a `local` implementation of each
   data module that calls the sidecar. Run it first as a plain web app (`vite`
   + sidecar) before Tauri.
4. **Tauri shell.** `src-tauri/`, sidecar bundling, Keychain, folder picker,
   watched folders UI, `.dmg` build in CI, plus a `brain mcp --stdio` entry
   for Claude Desktop/Code.
5. **Local models + meeting notes locally.** OpenAI-compatible base URL in
   Models settings (Ollama / LM Studio), local embeddings, whisper.cpp (or a
   local OpenAI-compatible STT) for meeting notes.
6. **Hosted later.** Decide whether hosted stays a separate product, becomes
   optional sync, or turns into federation between local brains.

## Open questions

- Keep or drop for local v1: Collections, Artifacts, To-dos, Links,
  Whiteboards, Cards, Memory, Skills? (Collections and Artifacts look core to a
  second brain. Whiteboards and Cards pull in Excalidraw and dnd-kit.)
- Admin-only governance pages (Usage, Guardrails, Security, Evals, Activity)
  make less sense for a single user. Drop them locally, or keep Evals for
  testing local models?
- Embeddings: a local model (for example `nomic-embed-text` through Ollama) by
  default, or OpenRouter, so search works offline?
- Should the hosted build eventually drop the now-unused tables (inbox,
  agents, loops, events, webhooks, features, knowledge_*)? That would be a
  destructive migration, so it waits until the local build is settled.
