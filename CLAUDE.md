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
- **Home dashboard (`src/pages/HomePage.tsx`, route `/home`):** a two-tab landing page.
  **Overview** is a live "what's going on" dashboard — quick actions, stat tiles (open
  to-dos with a completion bar, artifacts, files, events this week), a dependency-free
  14-day activity **trend chart**, a realtime **recent-activity feed**, and your open
  to-dos with inline complete. **Explore** keeps the original feature-card index + ⌘K
  search. Pure logic (day-bucketing, completion %, relative time, activity→dot mapping)
  is in `src/lib/dashboard.ts` (unit-tested). **Custom widgets (migration 0078):** users
  compose their own tiles — a `dashboard_widgets` row is `{kind: stat|list|chart, source,
  spec}` (owner-only, realtime). The "Add widget" prompt (`AddWidgetPanel`) drives the AI
  to call the seeded `create_widget` builtin from a natural-language description; the
  dashboard (`DashboardWidget`) renders each by querying its `source` (a fixed allow-list:
  todos/artifacts/files/links/collections/activity) under the caller's RLS — so a stored
  spec **can never read another user's rows**, and a customer adds widgets without forking
  the code (configuration-as-data, like tools/agents/forge). The allow-list + spec
  sanitizing lives in `src/lib/widgets.ts` (browser) and `_shared/widgets.ts` (the
  create_widget validator), both unit-tested. *(Planned: drag-reorder, workspace-shared
  widgets, more sources, a REST/MCP surface for widgets.)*
- **Chat:** `src/pages/ChatPage.tsx` writes user/assistant messages to Postgres and
  subscribes to `messages` via Supabase Realtime (websockets) for cross-device sync.
  The composer can **attach files** (📎): they upload to the `files` bucket (and show in
  Files), are stored on the message's `attachments` jsonb, and the chat function reads
  them — images/PDFs as content blocks, text inlined — so the assistant can parse them.
  Streaming comes from `src/lib/chat.ts` → `POST` to the `chat` edge function, which
  returns **SSE** lines `data: {"delta": "..."}` and ends with `data: [DONE]`.
  The function calls OpenRouter; the client only sends the message history + the user's
  access token (+ the anon key as the `apikey` header).
  **Background persistence (migration 0079):** the main composer sends
  `{conversationId, persist:true, runId}`, and the `chat` function finishes the model
  run and **writes the assistant message itself** (service role, as the caller) inside an
  `EdgeRuntime.waitUntil` background task — the same off-request pattern as
  slack-events/loop/evals. So reloading the page or navigating away mid-reply no longer
  loses it: the run completes server-side, `:::artifact` blocks are materialized there
  (shared `_shared/artifacts.ts` `parseArtifactBlocks`, unit-tested — a mirror of the
  frontend parser), and the saved artifact/message rows are handed back over SSE
  (`data:{"artifact":…}` / `data:{"message":…}`) for an instant in-place update while
  connected; a disconnected client picks them up via the existing `messages` Realtime
  subscription (or a remount). Because a dropped SSE looks identical whether the user
  navigated away (→ keep going) or hit **Stop** (→ halt), Stop writes
  `conversations.cancel_requested_run = runId`; the task checks that marker between tool
  turns and again right before it persists, and if it matches the in-flight run it stops
  and **saves nothing** (scoped by runId so a stale marker can't cancel the next send).
  Skill runs, the Cards board chat panel, and the Collections bubble omit `persist`, so
  they keep the classic client-side insert path (server streams and aborts on disconnect,
  unchanged).
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
  **Soft delete / archive + recovery (migration 0101):** artifacts (and skills) carry a
  nullable `deleted_at`. Deleting ARCHIVES by default (sets `deleted_at`) — the row is
  hidden from every normal view (grids, search, `p`/share pages, collections context) but
  stays recoverable; a real row DELETE is the permanent removal. The owner still sees their
  own archived rows over RLS (that's the recovery area — the SELECT policy hides archived
  only from non-owner branches, and the security-definer share RPCs got the same guard);
  service-role edge reads (`chat`/`orchestrator` always-on prompts, `collections.ts`,
  `security.ts`, the REST list) filter `deleted_at is null` in code since RLS is bypassed.
  The `Trash` panel on `ArtifactsPage`/`SkillsPage` restores or deletes-for-good; the
  editor/bulk "delete" buttons archive. Both the internal assistant and the external MCP
  server get the lifecycle: `delete_artifact` / `delete_skill` (archive by default,
  `permanent:true` to destroy), `restore_artifact` / `restore_skill`, and an `archived`
  filter on `list_artifacts` / `list_skills` (the recovery area). Handlers in
  `_shared/builtins.ts`; the MCP server delegates via `runBuiltin`.
  **Optional share password (migration 0062):** when an artifact is unlisted/public the
  editor's Sharing panel (`VisibilityControl`) can require a password before a viewer sees
  it — for handing a customer a link + password. This is NOT client-side theater: setting a
  password (owner-only `set_artifact_password()` RPC, bcrypt via pgcrypto) makes the read
  RLS policy **hide the whole row from non-owners** (`visibility <> 'private' AND
  share_password_hash IS NULL`), so the content never reaches anon. The viewer pages
  (`PublicArtifactPage`, `StandaloneArtifactPage`) share `useSharedArtifact()`
  (`src/components/ArtifactPasswordGate.tsx`): a normal RLS read still fast-paths
  non-password shares; when it comes back empty, `artifact_share_meta(slug)` says whether a
  password is needed and `get_shared_artifact(slug, password)` (security-definer, returns the
  row WITHOUT the hash only when the bcrypt check passes) unlocks it. Pure branching logic
  (password validation, gate decision) is in `src/lib/artifactShare.ts` and unit-tested. The
  raw `p` edge function has no gate, so password-protected artifacts simply 404 there.
  **Inline images (GitHub-style):** in `ArtifactEditorPage` you can paste, drag-drop, or
  attach (📎 "Image") an image into the body; it uploads to the **public `artifact-images`
  bucket** (migration 0059) and a markdown `![](url)` link is spliced in at the caret. The
  bucket is public (not owner-private like `files`) on purpose: the URL is baked into stored
  markdown and re-rendered forever — a signed URL (7-day max) would break — and it must load
  for anonymous visitors once the artifact is shared. Objects live under
  `‹owner›/‹uuid›/‹name›` (unguessable "secret-URL" privacy, same trust model as public
  slugs); writes are folder-scoped, reads are public. Pure logic (image detection, filename
  sanitizing, cursor-aware markdown insertion) lives in `src/lib/artifactImages.ts` and is
  unit-tested; the resilient upload reuses `uploadPickedFile(path, file, bucket)`.
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
- **Whiteboards (Planner — Excalidraw canvases, migration 0074):** a `whiteboards` row is a
  planning canvas — a `title` + a `scene` jsonb (the Excalidraw scene: `{elements, appState,
  files}`), a structured "file" the AI can read. `WhiteboardsPage` (route `/whiteboards`,
  sidebar **Planner**) is the list/create + collection filter (the shared `AddToCollectionBar`
  gained a `whiteboard` kind); `WhiteboardEditorPage` (`/whiteboards/:id`, **lazy-loaded** in
  `App.tsx` because `@excalidraw/excalidraw` is large — the first `React.lazy` in the app; Vite
  needs `define: {'process.env.IS_PREACT'}` or the bundle throws) embeds the Excalidraw canvas.
  Visibility mirrors links/todos: `private` (owner + admins) or `workspace` (every member can
  see **and** collaborate), enforced by RLS; `collection_whiteboards` is the many-to-many join
  (mirror of `collection_links`), so a board files into collections and the generic
  `collection.item_added` trigger learns it. **Real-time multiplayer:** the editor opens the
  app's **first Realtime broadcast + presence channel** (`whiteboard:‹id›`) — local `onChange`
  broadcasts the scene (debounced) and `onPointerUpdate` broadcasts cursors (throttled), remote
  peers apply them via `excalidrawAPI.updateScene({elements})` / `{collaborators}`; presence
  drives the live peer count. Echo is suppressed with a per-element version **signature**
  (`sceneSig`) so applying a remote scene doesn't re-broadcast. The scene is **autosaved**
  (debounced) to `whiteboards.scene` as the durable store, and the SAME channel carries a
  `postgres_changes` UPDATE subscription so the assistant's `update_whiteboard` writes (which
  don't broadcast) — and other devices — render live; if broadcast ever drops, save +
  postgres_changes keeps everyone eventually-consistent. **AI reads AND draws:** the pure,
  unit-tested `supabase/functions/_shared/whiteboard_scene.ts` (`sceneToText` renders a board's
  text/shapes/arrows to a readable summary; `normalizeElements`/`buildScene` turn the loose
  skeleton elements the model writes — with a `label:{text}` convenience → a bound text child —
  into renderable Excalidraw elements). `loadCollectionsContext` injects each collection's
  whiteboards as text (budgeted like artifacts), and seeded `is_builtin` tools
  `create_whiteboard` / `list_whiteboards` / `get_whiteboard` / `update_whiteboard` (replace or
  append elements) / `add_whiteboard_to_collection` (in `_shared/builtins.ts`; same names on the
  MCP server) let chat/scheduler/webhook agents and an external Claude read a board and draw on
  it — "draw me a flowchart", "check what's on the board". Emits `whiteboard.created/updated`
  events. *(Planned: public read-only `/share/w/:slug` snapshot pages like artifacts; a live
  board panel in Chat; whiteboards counted in the collection token meter; self-hosted
  Excalidraw fonts instead of the default CDN.)*
- **Card boards (Planner — free-form card walls, migration 0075):** the second Planner
  surface (sidebar **Cards**, under Assets next to Whiteboards). A `card_boards` row is a
  `title` + a `cards` jsonb array (`[{id, text, color, x, y}]`) — deliberately NOT a Kanban:
  you dump cards and drag them anywhere, position IS the priority ranking. Low-friction on
  purpose — `CardBoardEditorPage` (`/cards/:id`) is a **dependency-free drag canvas** (no
  Excalidraw): double-click empty space to add a card in edit mode, drag its top bar to move
  (pointer-events + `cardsSig` echo suppression), × to delete, a swatch to recolor. Sticky
  pastel colors (solid, dark text) read the same in light/dark. `CardBoardsPage` (`/cards`)
  is the list/create + collection filter (the shared `AddToCollectionBar` gained a
  `card_board` kind). Visibility mirrors whiteboards (`private`/`workspace`, RLS-enforced);
  `collection_card_boards` files a board into collections and the generic
  `collection.item_added` trigger learns it. **Real-time multiplayer** reuses the whiteboard
  pattern: a broadcast+presence channel (`card_board:‹id›`) syncs card moves live + drives the
  peer count, the `cards` jsonb is debounced-autosaved as the durable store, and a
  `postgres_changes` UPDATE subscription on the same channel renders the assistant's writes
  (and other devices) live. **AI reads AND fills:** the pure, unit-tested
  `supabase/functions/_shared/card_board.ts` (`cardsToText` renders the cards top-to-bottom as
  a prioritized list; `normalizeCards`/`buildCards` auto-position the loose `{text,color?}`
  cards the model writes). `loadCollectionsContext` injects each collection's boards as text,
  and seeded `is_builtin` tools `create_card_board` / `list_card_boards` / `get_card_board` /
  `add_cards` / `add_card_board_to_collection` (in `_shared/builtins.ts`; same names on the MCP
  server) let chat/agents and an external Claude dump ideas as cards and read a board
  ("brain-dump these 10 ideas as cards", "what's the top priority on the board"). Emits
  `card_board.created/updated` events. **Chat panel (persistent):** the editor's **Chat**
  button opens `BoardChatPanel` (`src/components/BoardChatPanel.tsx`) — unlike the ephemeral
  CollectionsPage bubble, it's backed by a REAL conversation found-or-created for
  (owner, `conversations.card_board_id`, migration 0076) in the same conversations/messages
  tables the main Chat uses, so history persists, syncs over Realtime, and shows up in the
  chat list. It streams via `streamChat({ cardBoardId })`; the chat function injects THAT
  board's `cardsToText` as primary context (access re-enforced: own or workspace) and tells the
  assistant to `add_cards`/`get_card_board` by id — so "add cards for X" writes to the board and
  the canvas re-renders live over the existing `postgres_changes` subscription.
  *(Planned: card-boards in the collection token meter; public share snapshots; card
  size/richer content; the same persistent chat panel on whiteboards + the collections bubble.)*
- **Knowledge compiler (compiled knowledge, migration 0112):** the shift from a
  *workspace with search* to a *knowledge compilation system*. The default flow used to be
  "add information → search for it later → generate an answer", which makes the model
  re-interpret raw documents on every question; the compiler makes it "add information →
  interpret it → link it → update existing knowledge → flag conflicts → produce a brief".
  The distinction everything follows from: **a raw file is no longer an answer, it is
  EVIDENCE** — the answer lives on a compiled page, and every compiled claim keeps a pointer
  back to the source it came from. A `knowledge_pages` row is a maintained page
  (concept/decision/process/person/project/terminology/principle/question/profile) with a
  stable `key` (a slug, so a refined page overwrites IN PLACE rather than minting a
  near-duplicate — the failure mode the whole feature exists to prevent), a lifecycle
  `status` (compiled/needs-review/contradicted/stale/confirmed/archived) and a
  `human_confirmed` flag. `knowledge_claims` is the provenance layer (statement + source
  kind/id/label + captured_at + confidence + a normalized `fingerprint` so re-running a pass
  doesn't restate the same claim); `knowledge_links` records relationships;
  `knowledge_conflicts` is the review queue; `compile_runs` holds a pass + its change brief
  (+ a live `progress` checklist, same pattern as `security_scans`). **Collections become
  compilation domains:** a `compile_policies` row is the per-collection TRUST BOUNDARY —
  `autonomy` (`suggest` = nothing unattended | `guarded` (default) = creates + additive
  appends apply, rewrites go to review | `auto` = rewrites apply too), which source kinds
  feed it, which page kinds it maintains, `never_auto` guards matched against a page's kind,
  labels or title ("financial commitments", "client-facing"), a confidence floor and a
  staleness horizon. **Compilation is not unrestricted autonomous editing:** `supersede`
  (wholesale replacement) is never unattended at ANY level, a human-confirmed page is only
  ever appended to, and anything that contradicts compiled knowledge goes to review. All of
  that judgment is the pure, unit-tested `supabase/functions/_shared/compiler.ts`
  (`classifyUpdate` is the trust boundary; also policy normalization — an allow-list, so an
  unknown kind is DROPPED not trusted — the prompt builder, strict-JSON parsing that **fails
  closed**, page matching, claim fingerprinting, staleness, `formatChangeBrief`,
  `compiledContextBlock`), with the I/O in the `compile` edge function (`verify_jwt:false`,
  session JWT **or** `mcp_tokens` bearer like run-tool, plus a service-role internal path
  that honors `triggered_by` — mirroring loops/evals). **The compiler never resolves a
  contradiction**: it detects one, leaves the page alone, marks it `contradicted` and writes
  a review item; an update the boundary declined is parked as a `held` item WITH the body it
  wanted to write, so approving it later is a click not a re-run, and the page it
  targets is flagged `needs-review` (`shouldFlagPendingReview`) so
  `compiledContextBlock` warns inline — without that the page reads as settled
  truth while the revision waits in the queue and the review gate becomes a
  silent staleness bug (found by A/B-testing the feature against itself). Resolving marks the page
  human-confirmed (a person just read it) and restarts its freshness clock. **Center of
  gravity:** `loadCollectionsContext` now leads with a collection's compiled pages and
  follows with the raw material labelled as the evidence behind them (stale/contradicted
  pages flagged inline so the assistant says what's disputed instead of asserting it) —
  `search_documents` becomes the fallback for "nothing compiled yet" / "I need the exact
  wording" / "this page is disputed", not the primary intelligence layer. `KnowledgePage`
  (route `/knowledge`, Assets) is Review (conflicts first, on purpose) / Compiled / Briefs
  (live checklist while a pass runs) / Policy, realtime-subscribed. Eight seeded
  `is_builtin` tools in `_shared/compiler_tools.ts` (`compile_collection` /
  `list_knowledge_pages` / `get_knowledge_page` / `update_knowledge_page` / `list_conflicts`
  / `resolve_conflict` / `get_change_brief` / `set_compile_policy`) give every agent loop and
  an external Claude the same surface, delegated from the MCP server via `runBuiltin` so the
  two never drift — and `update_knowledge_page` is deliberately narrower than the compiler
  (append/revise only, human-confirmed pages append-only) so a tool call can't route around
  the boundary. A seeded always-on "Knowledge compiler" prompt teaches the discipline
  (compiled first, raw as evidence, never pick a winner). Emits
  `knowledge.page_created/page_updated`, `knowledge.conflict_detected` and
  `knowledge.compiled` events, so a listener can route a brief to Slack or react to a
  contradiction; a nightly pass is just an agent scoped to `compile_collection` on a
  `schedules` row. Full reference: `docs/knowledge-compiler.md`. *(Planned: retrieval over
  compiled pages instead of whole-page injection; a relationship graph view; publishing a
  compiled page to a durable artifact URL from the UI; a compiled workspace/personal profile
  page; compiling straight off an `event` as sources land.)*
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
  (`create_artifact` / `list_artifacts` / `get_artifact` / `create_collection` / `add_to_collection` /
  `list_collections` / `add_note` in `_shared/builtins.ts`, migration 0040), so chat + scheduled/webhook
  agents can ingest content into artifacts + collections + the knowledge base too (e.g. an agent that
  files fetched articles into a collection on a schedule or a GitHub webhook).
  **Reliable artifact→collection filing (migration 0067):** so "put this in collection X" never
  gets stuck, `create_artifact` returns the new **id** and accepts a `collections` array (file into
  several at once, each created if missing); **`list_artifacts`** lists your artifacts newest-first
  *with ids* (filter by collection/`title_contains`/`type`) so a freshly-created (or `:::artifact`
  auto-saved) row is retrievable in the same turn; `get_artifact` (id or exact title) and
  `add_to_collection` (now takes `artifact_title` as an id alternative) let the assistant file
  without ever seeing an id. All read the primary via the service role — no read-after-write lag.
  Pure branching (id detection, collection-ref parsing, limit clamping) lives in
  `supabase/functions/_shared/artifacts.ts` and is unit-tested (`tests/artifacts_test.ts`); the same
  handlers back the MCP server (`mcp/index.ts`) so external + internal Claude stay in lockstep. **Context-window awareness:** each collection shows an estimated token count
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
  task list that plugs into the collections concept. A `todos` row (migration 0041)
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
  `update_todo` / `add_todo_to_collection` (in `_shared/builtins.ts`; the MCP server
  **delegates these four to `runBuiltin`** so the external and internal paths never drift)
  so chat/scheduler/webhook agents and an external Claude can manage tasks.
  **Lifecycle lanes + five views (migration 0116):** binary `done` is enough for a
  checklist and not enough for a queue you actually work — "committed to but not started"
  and "waiting on someone else" both read as an unticked box. `todos.status` adds the lane
  (`triage` → `next` → `doing` → `blocked` → `done`) and `todos.source` records who filed
  it (`agent`/`api`/null-for-a-person). **`done` stays the source of truth for "closed"** —
  every older surface reads it (REST, the builtins, the Home dashboard tiles + the
  `dashboard_widgets` `status` spec, which means open/done and is untouched, the collections
  context block, the `todos_due_idx` partial index) — and the `todos_sync_status` BEFORE
  trigger reconciles the pair whichever half a writer sets, so a pre-0116 client can never
  leave a row contradicting itself. The rule is mirrored in the pure `reconcileStatus()`
  (`src/lib/todos.ts`) so the optimistic UI row equals the persisted one; the one asymmetry
  is deliberate: un-ticking lands in `next`, not `triage` (it reads as a correction). Every
  writer sends only the half it names. The page is now five views over the same filtered
  set — **List** (the original sortable list, still the default), **Board** (status lanes,
  drag to change state), **Time** (overdue/today/this week/later/no date, drag to
  reschedule — Overdue takes no drops, you can't schedule into the past), **Calendar**
  (month grid + an undated pile you drag onto a day) and **Focus** (one at a time, overdue →
  due today → blocked → agent-filed triage). All the grouping/ranking/date maths is pure and
  unit-tested in `src/lib/todos.ts`; the views themselves are `src/components/TodoBoards.tsx`.
  **Drag targets + live boards (migration 0120):** the WHOLE card is the drag surface — the first
  cut used a 16px handle that looked exactly like the checkbox beside it, so the boards read as
  having no drag at all. The pointer sensor's 4px activation constraint keeps a plain click a
  click, and the checkbox/title `stopPropagation` on pointerdown so ticking or opening a to-do
  never starts a drag. A **`DragOverlay`** renders the moving copy in a portal — without it the
  card is clipped by its own lane's `overflow-y-auto` and a cross-lane drag *looks* broken even
  when it works. Calendar day chips are draggable in their own right (`DayChip`), so a date
  changes by moving a chip day→day or back onto the undated pile; before, only the undated pile
  could start a drag and the calendar was a one-way trip. **Realtime:** `todos` +
  `collection_todos` joined the `supabase_realtime` publication (both `replica identity full`, so
  a DELETE carries enough row for Realtime to evaluate the SELECT policy and actually forward it),
  and `TodosPage` subscribes to `postgres_changes` — the server row is merged by id, so state
  converges regardless of who wrote it or what order events land in. RLS applies to the stream, so
  publishing widens nothing: a private to-do is only ever streamed to its owner. A row another
  session changed flashes an info ring for ~2.5s; the page tracks its own recent writes
  (`ownWrites`) so your own echo never flashes at you.
  *(Planned: per-lane WIP limits; a recurring-to-do rule; lanes on the Home dashboard tiles;
  presence on the board — who else is looking — reusing the whiteboard/card-board channel
  pattern.)*
- **Collection picker (one control instead of a chip wall):** every collection-aware page
  used to render one pill per collection in a wrapping row. That reads fine with six
  collections and falls apart at fifty — five lines of chips above the content, no way to
  find one by name, and the empty ones (a workspace accretes them) taking as much room as
  the ones you use. `src/components/CollectionPicker.tsx` is one button that opens a
  searchable, counted list, with a `CollectionTokens` row underneath showing what's picked;
  empty collections are hidden behind a "Show empty (n)" toggle, and a *selected* one stays
  visible even when a filter empties it. `mode="single"` replaces rather than accumulates,
  so a single-select page adopts it without changing its semantics. In use on
  `TodosPage` (multi), `ArtifactsPage`, `LinksPage`, `TerminologyPage` and `AgentsPage`
  (single). Pure logic (filtering, the empty rule, the trigger label) is
  `src/lib/collectionPicker.ts`, unit-tested. Note each page passes a **stable**
  `EMPTY_SELECTION` set rather than a fresh `new Set()` — the picker memoizes on
  `selected`. *(Planned: rolling it onto the Files/Whiteboards/Cards grids and the Chat
  collection picker, which has its own context-meter rows.)*
- **User memory (per-user, so new chats start warm):** a durable personal profile the
  assistant carries across conversations — the user's name, defaults, tone, stack, ongoing
  projects, standing preferences — so a fresh chat isn't a blank slate. A `user_memories`
  row (migration 0069) is `content` + optional stable `key` (for upsert-in-place, so a
  refined fact overwrites instead of duplicating) + `category` + `pinned` + `source`
  provenance. Access is **owner-only** (like `conversations`/`files`, deliberately NOT the
  private/workspace model — one user's memories never leak into another's context), enforced
  by RLS. `MemoryPage` (route `/memory`, Assets) lists/edits/pins/forgets them and is
  realtime-subscribed (the AI writes here too). The assistant reads/writes memory through
  seeded `is_builtin` tools **`remember` / `list_memories` / `update_memory` / `forget`**
  (handlers in `_shared/memory.ts`, run by all three agent loops via `runBuiltin`; the MCP
  server exposes the same names, so an external Claude uses one code path). The **chat and
  scheduler loops inject** the caller's memories into the system prompt via
  `loadUserMemories` — that's what makes a new chat / scheduled run pre-warmed. The **webhook
  and Slack loops deliberately do NOT auto-inject** (they face external callers; personal
  memory must not bleed into a reply to an untrusted source — those agents can still read it
  via `list_memories` if scoped in). Every write emits a `memory.created`/`memory.updated`
  **event** (0063, private visibility), so the automation layer works in both directions: a
  listener can react to a saved memory, and a listener's `run_tool → remember` can write
  memory in response to any event. A seeded always-on "User memory" prompt teaches the
  save/skip discipline (durable facts yes; secrets and one-offs no). The pure block formatter
  (`formatMemoriesBlock`, budget + truncation) is unit-tested (`tests/memory_test.ts`).
  *(Planned: a REST API + collection filing like todos/links; semantic recall instead of
  full-profile injection when a user accrues many memories.)*
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
  **Bulk sharing + public files (migration 0106):** select any number of files and share
  them in one action from the selection toolbar — a **permanent public link** or a signed
  link scoped to **1 hour / 1 day / 1 week** (the pure mode→expiry mapping lives in
  `src/lib/fileShare.ts`, unit-tested). A results modal lists each file's link with per-file
  copy + "Copy all". "Public" **publishes** the file: because the `files` bucket is private
  (signed URLs expire, max 7 days), publishing COPIES the bytes into a separate **public
  `public-files` bucket** (public read, owner-folder writes — same model as `artifact-images`)
  under the mirrored `‹owner›/‹uuid›/‹name›` path and records it on the nullable
  `files.public_path` column; the resulting stable, non-expiring URL (`publicFileUrl()` in
  `src/lib/supabase.ts`) is safe to bake into a **public artifact / static HTML page** whose
  images must load for anonymous visitors forever. A "Public" badge on a published file copies
  the URL (click) or unpublishes it (×, which drops the public copy — the private original is
  untouched); deleting a file removes both copies. Signed-link sharing still only flips
  `files.visibility` to `unlisted`; the private raw blob never leaves the `files` bucket unless
  explicitly published.
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
  `add_table_row` / `update_table_row` for an external Claude.
  **Public write-forms (migration 0110):** a table can accept ANONYMOUS submissions (a
  contact form / signup sheet baked into a shared artifact) WITHOUT opening the `ut_*`
  tables to `anon`. A `table_forms` row is owner opt-in, per table: `{table_id, owner_id,
  token, fields}` where `fields` is a column ALLOW-LIST (`[{key, required}]`). The browser
  never touches the anon key — the sandboxed artifact iframe (opaque origin, no session)
  POSTs `{token, values}` to the public **`form-submit` edge function** (`verify_jwt:false`),
  which runs as the service role and enforces everything in code: resolve the opaque token →
  form (secret-URL capability, like `webhooks.token`), re-verify the form's owner can still
  WRITE the table (no privilege escalation), drop everything not on the allow-list
  (insert-only), force `owner_id` to the form's owner (no spoofing), validate required fields
  + coerce types, and cap submissions per rolling hour (abuse control via `activity_log`
  `form.submission`). RLS on `table_forms` is owner/admin-manage with a `with check` that also
  requires the owner can write the referenced table. Pure logic (allow-list intersection +
  type coercion in `_shared/forms.ts`; the paste-able HTML snippet builder in
  `src/lib/forms.ts`) is unit-tested (`tests/forms_test.ts`, `src/lib/forms.test.ts`). Owners
  manage forms from the Tables UI ("Forms" button → pick columns/required, copy the HTML
  snippet + token). This is the **write half only** — public reads are a deliberate follow-up
  (a public read would expose everyone's rows, so it needs a curated surface, not this table).
  *(Planned: public read via a curated/published view or aggregate; an assistant
  `create_table_form` builtin; auto-generate the form artifact; optional shared secret +
  CAPTCHA/honeypot; a fuller query surface — sorting, richer filters/joins — and column
  reordering/rename.)*
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
- **Settings & feature flags (migration 0065):** Settings is a sidebar SECTION
  (like Assets/Automation), one route/page per area under `/settings/*`
  (`src/pages/settings/`): Profile + Connect Claude (all users), Models, Timezone, Email,
  Slack, External MCP, Invite people, and **Feature flags** (admin). The sidebar is now driven
  by ONE config, `src/lib/nav.ts` — Layout renders it, the ⌘K palette (`GlobalSearch`)
  jumps to its pages, and the Feature flags page lists its flaggable items, so the three
  never drift. **Feature flags are feature HIDING, not permissions:** a `feature_flags`
  row `{key, enabled:false}` (admin-writable, everyone-readable, realtime) removes a
  sidebar area (and its palette entry) workspace-wide — because the company doesn't use
  it or you're trying something out. RLS still protects the data; hiding a link doesn't
  gate the route. Absence of a row = enabled (fresh workspaces show everything). Core
  areas (Home, Chat, and every Settings item) are `alwaysOn` so a flag can never hide the
  page that manages the flags. Layout subscribes to `feature_flags` so toggles apply live.
  The pure filtering logic (`isFeatureEnabled`/`visibleGroups`/`flaggableGroups`) lives in
  `nav.ts` and is unit-tested (`src/lib/nav.test.ts`).
- **Workspace timezone (migration 0092):** the IANA clock the agentic automations treat
  as "local" so unattended runs stop assuming UTC. A single `workspace_settings` row
  (`{key:'timezone', value}`, a tiny admin-write/member-read/realtime KV mirroring
  `feature_flags`) is edited in **Settings → Timezone** (`TimezoneSettings`, route
  `/settings/timezone`, admin-only): it shows the saved zone, the admin's browser zone
  (one-click "Use this"), a full IANA picker (`Intl.supportedValuesOf`) with a live
  current-time + UTC-offset preview. Absence of a row / invalid value = `'UTC'`. The
  server helper `supabase/functions/_shared/timezone.ts` (`resolveWorkspaceTimezone(db)`
  reads the row; pure `currentTimeSection(tz, now)` / `formatInZone` / `isValidTimezone`
  are unit-tested in `tests/timezone_test.ts`) is called by **all six agent loops** —
  chat, scheduler, event-dispatch, webhook, slack-events, loop — which prepend
  `currentTimeSection` to their system prompt, so every automation is told the real local
  date/time (before this, NONE injected "now" into the model). The scheduler uses a
  schedule's own `timezone` when set and falls back to the workspace zone; new schedules in
  the agent editor default their timezone to the workspace zone (existing schedules keep
  theirs). Browser-side pure helpers live in `src/lib/timezone.ts`
  (`detectBrowserTimezone`/`allTimezones`/`formatCurrentTime`/`utcOffsetLabel`,
  unit-tested `src/lib/timezone.test.ts`). *(Planned: per-user display timezone; a generic
  `workspace_settings` surface for other workspace-wide config.)*
- **Events & listeners (automation substrate, migration 0063):** a workspace
  pub/sub layer, deliberately SEPARATE from `activity_log` (which stays the human feed).
  Every meaningful record change emits an `events` row via SECURITY DEFINER DB triggers
  through the `emit_event(...)` helper — `artifact.created/updated`, `file.created/deleted`,
  `todo.created/completed`, `link.created`, `chat.created`, `message.received`, and the
  headline `collection.item_added` (one generic trigger over every `collection_*` join
  table, carrying `{collection_id, item_type, item_id}`). Each event carries a stable
  `entity_type`/`entity_id`, workspace `visibility` (so listeners react safely to shared
  activity), and a `processed_at` dispatch cursor. `EventsPage` (route `/events`,
  Automation) is the live feed. An `event_listeners` row is a rule — `event_type` (exact,
  `file.*` prefix wildcard, or `*`) + a `match` jsonb (`entity_type`/`collection_id`/`source`
  filters) + an `action_type` (`run_agent` | `run_tool` | `add_to_collection` | `log`) +
  `action_config`. `ListenersPage` (route `/listeners`, Automation) is the "when this /
  do this" CRUD, with recent `event_listener_runs`. The **`event-dispatch` edge function**
  (`verify_jwt: false`, cron-secret gated like the scheduler; ticked by pg_cron via pg_net —
  the `cron.schedule` is applied out-of-band after deploy, same convention as 0010) claims
  unprocessed events (one-time `processed_at` claim = idempotent), matches them with the
  pure `_shared/events.ts` `matchListener` (unit-tested), and runs each action AS the
  listener's owner (agent loop mirrors the scheduler; `run_tool` mirrors run-tool's dispatch;
  `{{event}}` in a tool input is replaced with the event JSON). Per-tick action cap +
  the one-time claim bound runaway chains. RLS mirrors links (own/workspace/admin). Each
  dispatch logs `activity_log` `listener.run`/`listener.error`.
- **Unified inbox (messages from any source, migration 0064):** one place to push every
  message — email, Slack, WhatsApp, SMS, generic webhook/manual pushes — so a person (and
  the team, via collections) can read them, chat over them, and automate on them.
  Generalizes the old email-only `inbox_messages` (0016) in place rather than adding a
  colliding `messages` table (that name is chat's): adds `owner_id`/`visibility` (the
  private-or-workspace model of links/todos, replacing admin-only RLS), `source`,
  `from_name`/`url`/`external_id`, realtime, and a `collection_inbox_messages` join (mirror
  of `collection_links`). Each incoming row emits `message.received` (0063), so
  listeners can react ("when a Slack message arrives, run this agent"). `InboxPage`
  (route `/inbox`, top nav) lists/filters by source, marks read, files into collections,
  and composes manual messages. **Ingestion:** `email-inbound` now writes email rows here
  (`source='email'`, workspace-shared); the token-gated public **`message-inbound`** edge
  function (`verify_jwt: false`, `mcp_tokens` bearer like run-tool) accepts arbitrary
  pushes (Slack/WhatsApp/Zapier/scripts); seeded `is_builtin` tools
  `save_message`/`list_messages`/`add_message_to_collection` let the assistant + agents
  capture messages. `check_email` still works, now scoped to `source='email'` rows.
  *(Planned: IMAP/Google/Microsoft account connectors that funnel into this table;
  injecting a collection's messages into `loadCollectionsContext`; a REST API + MCP tools.)*
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
- **Slack bot (rooms bound to collections):** the workspace bot joins Slack channels and
  answers `@mentions` with that room's context — Claude-Tag style. An admin connects the
  Slack app once in **Settings → Slack** (bot token + signing secret, Vault-backed like
  email/MCP: `set_slack_integration` / service-role-only `read_slack_secrets`, migration
  0057), then **binds channels**: a `slack_channel_bindings` row maps a Slack `channel_id`
  to `collection_ids` + an optional `agent_id`; the binding's creator is the identity the
  bot runs as (like `webhooks.owner_id`), so bind workspace-visibility collections for team
  rooms. The public **`slack-events` edge function** (`verify_jwt: false`; gated by the
  HMAC `X-Slack-Signature` on every request, not a URL token) handles the Events API:
  `url_verification` challenge, signature + replay-window check, dedupe on `event_id`
  (unique insert into the admin-readable `slack_events` audit log), then **acks within
  Slack's 3-second window and does the model work in the background**
  (`EdgeRuntime.waitUntil`) — the reply goes back via `chat.postMessage` into the thread.
  The background run is the same loop as webhooks: agent instructions (or a default
  Slack-flavored prompt) + `loadCollectionsContext` (binding ∪ agent collections) +
  `runGuardrails` in the `webhook` context (**fail closed**) + tools only when the binding
  sets `allow_tools` (deterministic gate, mirroring `webhooks.allow_tools`). Thread/channel
  transcript (`conversations.replies`/`.history`) and display names are fetched for
  conversational context; bot/self messages and edit subtypes are skipped so it can't loop.
  Pure logic (signature verify, mention stripping, Slack-text decode, markdown→mrkdwn,
  skip rules, transcript formatting) lives in `_shared/slack.ts` and is unit-tested
  (`tests/slack_test.ts`). Usage logs with `context='slack'`; replies log `slack.reply` to
  the activity feed. Setup guide + app manifest: `docs/slack.md`.
  **Ambient participation (Claude-Tag style, migration 0066):** a binding can set
  `mode='ambient'` to have the bot **listen to every message** (not just @mentions) and a
  cheap model decide whether to chime in. The manifest then subscribes to `message.channels`/
  `message.groups`; the function handles `message` events for ambient channels only (plain
  channels stay mention-only — zero regression). Flow per message: capture it into the unified
  inbox (`inbox_messages`, `source='slack'`, when `capture_messages`) → skip if it @mentions
  the bot (the `app_mention` event handles those, no double reply) → a pure `passesAmbientPrefilter`
  heuristic drops trivial/reaction messages before any model call → `decideParticipation` runs
  ONE `orComplete` on the binding's `gate_model` (any OpenRouter slug, else the `utility`
  profile) with `buildParticipationSystem(participation_prompt)` and returns a strict-JSON
  verdict via `parseParticipationVerdict` (fails **silent** — a false positive/spam is worse
  than a miss). On `respond:true` it runs the same reply path as an @mention. The new pure
  helpers live in `_shared/slack.ts` and are unit-tested. *(Planned: DMs, a
  `send_slack_message` builtin for scheduled/ambient posts, in-channel binding commands, a
  per-thread cooldown, name-resolving captured messages.)*
- **Prompts & skills:** one `skills` table, two modes.
  - `auto_apply = true` → **always-on** prompts (admin-managed, workspace-wide). The
    seeded `is_builtin` "How this workspace works" prompt teaches the assistant the
    system + the artifact protocol. The chat edge function loads all `auto_apply`
    rows (via service role) and concatenates them into the system prompt on every call.
  - `auto_apply = false` → **on-demand** skills (personal). In `ChatPage`, typing `/`
    (or the ⚡ button) lists them. Picking one **arms** it rather than firing a model
    call on the click: `chooseSkill()` prefills the composer with `use the skill "…"`
    (`skillInvocationSentence()` in `src/lib/util.ts`) and shows a cancelable chip, so the
    user can add context and decide when to run. Sending then routes through `handleSend`
    → `runSkill()`, which sends the skill as the `system` (artifact mode uses
    `replaceSystem: true` for clean output; reply mode appends to context).
- **Tools (tools-as-data):** the `tools` table defines capabilities the chat loop
  exposes to the model. `kind = 'http'` → a custom tool; the model calls it and the chat
  function POSTs the inputs to `config.url` and feeds the response back. `kind = 'web'`
  → switches on OpenRouter's **web search server tool** (`{type:'openrouter:web_search'}`
  in the `tools` array — NOT the deprecated `plugins:[{id:'web'}]`, which injected results
  as a mid-conversation system message that Anthropic 400s on multi-turn threads), the
  portable replacement for Anthropic's server-side web tools (works with any OpenRouter model).
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
- **Security dashboard (Governance):** `SecurityPage` (route `/security`, sidebar
  "Security" under Governance, admin-only) is the workspace posture scan as a repeatable
  feature. The seeded `run_security_scan` builtin (handler `_shared/security.ts`, migration
  0058 — first shipped as a second `0056_*.sql`, which collided with
  `0056_conversation_pinned.sql` and silently never deployed; renumbered + made idempotent)
  runs **deterministic checks over configuration** — active webhooks without shared
  secrets, tool-enabled (`allow_tools`) webhooks, missing blocking webhook guardrails,
  `send_email` without a recipient allowlist, `get_secret` + workspace-scoped vault secrets,
  active external MCP handles, MCP/API tokens unused ≥90 days, public-artifact inventory,
  single-admin bus factor — and writes `security_scans` / `security_findings` rows
  (admin-only RLS; inserts are service-role). Findings are config facts, not model opinions:
  the only model call is one best-effort `utility`-profile summary (fails open to a computed
  one; usage context `security`). The pure evaluator (`evaluatePosture(snapshot)`) is
  deliberately import-side-effect-free (lazy model imports) and unit-tested in
  `supabase/functions/tests/security_test.ts`. Findings carry a stable `key`, so a
  **dismissed** (accepted-risk) or **promoted** status carries over across re-runs instead of
  re-nagging. **Promote to feature** files the finding onto the Features board in the `idea`
  lane — the existing human-approval drags spend the AI effort and ship the fix; the button
  itself never touches GitHub. Trigger surfaces (zero new plumbing, it's an ordinary builtin):
  the dashboard's "Run scan" button calls it via `run-tool`; a daily run is an agent scoped to
  this tool on a `schedules` row; chat works too. The builtin re-checks `profiles.is_admin`
  in code, since the loops run builtins with the service role. **Live progress:** the scan
  row carries a `progress` jsonb checklist (`SCAN_STEPS`/`scanProgress` in `_shared/security.ts`,
  written step-by-step by `runSecurityScan`), and `security_scans` is in the
  `supabase_realtime` publication — the dashboard subscribes and renders the running scan's
  steps ticking live, then refetches findings when the row flips to `ok`/`error`.
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
  cadence) is run by the `scheduler` edge function, which a `pg_cron` job ticks every
  minute (via `pg_net`, authed by a `cron_config` secret). Cadence is EITHER a fixed
  `interval_minutes` OR — for exact times the interval can't express (the 15th of the
  month, the last day of the month, weekdays at 9am) — a standard 5-field **cron
  expression** (`schedules.cron_expr` + `schedules.timezone`, migration 0091). When
  `cron_expr` is set it owns the cadence: the scheduler computes `next_run_at` from it in
  the schedule's timezone instead of `now + interval_minutes` (an invalid expression
  pauses the row + logs `schedule.error`, so it can't spin). The next-run math is the pure,
  unit-tested `supabase/functions/_shared/cron.ts` (`nextCronRun`/`isValidCron` via
  **croner**, which supports `L` = last day of month); the browser mirror
  `src/lib/cron.ts` (croner + **cronstrue**) drives the agent editor's cron field — a live
  plain-English description, a next-3-runs preview, and a `* * * * *` syntax helper — beside
  the classic interval presets. Manage schedules inside the agent editor. (Both cron
  precision and the old interval are floored to the 1-minute pg_cron tick.)
- **Capability workers (agent jobs, migration 0080):** turn heavy open-source
  libraries into specialized **Docker workers** that do focused jobs for the main
  AI, so the app never shells out to big binaries in-process. First two: **office**
  (Word/Excel/PowerPoint via LibreOffice) and **media** (audio/video via ffmpeg).
  Deliberately **no `agents` table** — the capability contract lives in skill files
  (`skills/capability-workers.md` + `officecli.md`/`ffmpeg.md`, also seeded into the
  `skills` table), coordination is the **`agent_jobs`** queue, and execution is a
  container. Flow: the AI's `create_agent_job` builtin inserts a `queued` row → a
  worker atomically claims it (`claim_agent_job` RPC, `FOR UPDATE SKIP LOCKED`) →
  downloads inputs from Storage (ownership re-verified per file) → runs the
  allow-listed operation in a temp dir → uploads outputs + writes `result_manifest`
  → marks it `completed`; the AI polls `get_agent_job`. Statuses queued/claimed/
  running/completed/failed/retrying/cancelled/dead_letter; lease + heartbeat
  (`lease_expires_at`, `recover_stale_agent_jobs`) recover a crashed worker's job;
  transient failures retry with 30s→2m→10m backoff; an `idempotency_key` prevents
  duplicate outputs (one open job per owner+key). Pure logic (validation, manifest,
  idempotency, backoff, failure policy) is in `supabase/functions/_shared/agent_jobs.ts`
  (unit-tested); builtins `create_agent_job`/`get_agent_job`/`list_agent_jobs`/
  `cancel_agent_job` in `_shared/builtins.ts`; an `agent_job_events` table logs each
  job's timeline (realtime). The workers are a **separate npm workspace**
  (`workers/`, NOT in the main app build/CI) sharing `@supanet/worker-shared` (claim
  loop, storage I/O, lease/health/events). **Railway is the first deploy target, not
  the architecture:** the worker runtime touches only Postgres + Storage + env vars
  (no Railway SDK/hostnames in `src/`), so the same image runs on Docker Compose/
  Railway/Fly/Render/K8s — local dev is `infra/docker-compose.yml`, Railway config is
  isolated under `infra/railway/`, and `.github/workflows/deploy-workers.yml` builds
  both images on change (deploys when `RAILWAY_TOKEN` is set). Full reference:
  `docs/capability-workers.md`. *(Planned: PDF/OCR/browser/image workers on the same
  protocol; a jobs UI; pg_cron lease-recovery tick.)*
- **MCP server:** `supabase/functions/mcp/index.ts` is a JSON-RPC-over-HTTP MCP
  server (`verify_jwt: false`) an **external** Claude connects to. Auth is a per-user
  `mcp_tokens` token (Settings → Connect Claude); every action runs as the token's owner.
  **Claude Code** connects directly (`claude mcp add --transport http …`); **Claude
  Desktop** launches MCP servers as local processes, so it connects through the
  `mcp-remote` bridge in `claude_desktop_config.json` (Settings → Connect Claude emits
  both snippets; the `Authorization:${AUTH_HEADER}` env split avoids mcp-remote's
  space-in-header bug). It exposes build tools (`create_agent`, `create_http_tool`,
  `create_skill`, `create_webhook`, `create_artifact`, `list_*`) so an outside Claude can
  push agents/tools into the workspace, where they appear in the dashboard. Skills and
  always-on prompts (the same `skills` table) get full CRUD — `create_skill` / `list_skills`
  / `get_skill` / `update_skill` / `delete_skill` — with the DB's access rule re-enforced in
  code (personal on-demand skills owner-managed; always-on prompts admin-only; built-in
  prompts editable but not deletable). **These build tools are also `is_builtin` tools
  (migration 0084), so the INTERNAL assistant + the scheduler/webhook/Slack agent loops can
  build agents/tools/webhooks/skills too — not just an external Claude.** The handlers moved
  into `_shared/builtins.ts` (`runBuiltin`) and the MCP server now delegates to them (like
  the files/memory/whiteboard tools), so both paths share one implementation and never
  drift; the same admin gates re-check in code (`create_http_tool` + always-on prompts are
  admin-only), since the loops run as the service role. It also drives
  the **looping system** (`create_loop` / `run_loop` / `get_loop_run` / `list_loops`): an
  external Claude hands a loop a goal (prompt) + rubric + budget + iteration cap, kicks off a
  run, then polls `get_loop_run` to "check in" until it's done — same machinery as the Loops
  dashboard. The shared `_shared/loops.ts` helpers (create the loop, trigger the `loop` edge
  function, format a run) back both this and the in-app builtins so they never drift; an
  internal trigger passes `triggered_by` (honored only for the service-role caller, which has
  no JWT `sub`) so the run is attributed to the right user. It also drives the **evals system**
  (`list_evals` / `create_eval_suite` / `add_eval_cases` / `run_eval` / `get_eval_run`, all
  admin-gated in code): an external Claude builds a Promptfoo-style suite, **bulk-inserts cases
  it generated** (`add_eval_cases` takes an array — the answer to "making cases is a lot of
  work"), then runs it and polls — the same trigger→poll shape as loops. `run_eval` takes a
  `models` list to **compare several models on the same suite in one call** (one background
  `eval_run` per model — the `model` column already existed — and `get_eval_run` renders a
  best-first side-by-side scorecard via `formatMatrix`). The shared `_shared/evals.ts`
  (`triggerEvalRun` posts to the `evals` function with the service-role key + `triggered_by`;
  `executeSuiteRun` does the per-case work) backs both this and the in-app UI so they never
  drift; the pure helpers (`evalAssertion` / `parseModels` / `formatMatrix`) live in the
  import-side-effect-free `_shared/evals_pure.ts` and are unit-tested (`tests/evals_test.ts`).
  The `evals` function now runs in the **background** (`EdgeRuntime.waitUntil`) when called with
  `background:true`, returning run ids immediately; the admin UI's single synchronous run is
  unchanged. **Collection as a grounding set (migration 0072):** an `eval_suites.collection_ids`
  binds a chat/agent suite to one or more collections — every case is answered with ONLY that
  collection's content injected as primary context (`runOrchestrator` now takes `collectionIds`
  → `loadCollectionsContext`, layered after the system prompt, not replacing it) and the judge
  grades against the case's reference, so you can test "does the assistant answer correctly out
  of THIS knowledge set". Cases stay hand-authored; the collection is the knowledge, not the
  cases. **Tool-usage evals (migration 0083):** a chat/agent suite can also assert what the
  assistant *does*, not just what it says — `runOrchestrator` returns the full tool-call
  **trace** (name + args + result), and new assertion types grade it: `calls_tool` /
  `not_calls_tool` (the safety/prompt-injection guard — "an untrusted input must NOT call
  send_email") / `calls_tool_with` (arg match via `arg_contains`/`arg_regex`) /
  `tool_call_count` (min/max/equals). Runs are **sandboxed by default** (`eval_suites.sandbox_tools`):
  only read-only builtins execute (`isReadOnlyBuiltin` — `list_/get_/query_/search_` + check_email,
  minus get_secret); every side-effecting/external tool (create_*, send_email, http, MCP) is
  captured but NOT run, so a tool-usage suite is safe to re-run across a model matrix on a
  schedule without mutating the workspace — set `sandbox_tools:false` for an opt-in real-side-effects
  integration test (where the Activity/Events feeds become the verification layer). A case with
  only tool assertions and no reference/rubric passes on its assertions alone (judge skipped). A
  fourth **`tool` target** runs a tool directly (no model, like `rag`) — case input is JSON
  `{"tool","input"}` — to test a tool in isolation. `get_eval_run` by **run_id** now returns a
  per-case breakdown (tools called + failed assertions + judge reason) so tool usage is fully
  measurable over MCP, not just a headline score. All the pure logic (the tool assertions,
  `isReadOnlyBuiltin`, `summarizeTrace`, `formatRunDetail`) is in `_shared/evals_pure.ts` and
  unit-tested. **Collection as a two-way hub:**
  `get_collection` pulls a whole named collection in ONE call — meta + artifacts (full content),
  files (signed urls), links, to-dos (full notes), tables (schema + row count), and inbox
  messages — with an optional `since` (ISO 8601) for a cheap daily diff and an `include` subset;
  it assembles the bundle inline (mirroring `_shared/collections.ts`'s owner/visibility rules,
  since this server runs as the service role), while `since`/`include` parsing is the pure,
  unit-tested `_shared/collection_hub.ts`. The push side has parity: `create_artifact` /
  `update_artifact` (edit a running-memory doc in place) / `add_note` (also files a text artifact
  into the collection so it shows up in `get_collection`) / `save_link` / `save_message` /
  `create_todo` / `upload_file` all take a `collection`, and the read gaps are closed too
  (`get_artifact`, `list_links`, `list_messages`, `search_documents`, `get_activity`, plus a
  `since` filter on `list_artifacts` / `query_table`). The write/read helpers that already exist
  as `is_builtin` tools are **delegated to `runBuiltin`** (like the files/memory tools) rather
  than reimplemented, so they never drift. *(Planned — see `docs/tasks/`: a tabbed
  Code/Desktop connect UI.)*
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
  (Phase 2, not built)** — every row is workspace-wide for now.
  **Re-exposed through the MCP *server* (Playwright & other browser tools):** the same
  connected external MCP servers are also surfaced back OUT through our own `mcp` server —
  the `mcp` function's `tools/list` appends each active `kind='mcp'` handle's discovered
  toolset (via the shared `expandMcpTools`, so the tool names match exactly) and `tools/call`
  routes any namespaced `‹label›__‹remote›` name it doesn't implement itself to `runMcpTool`.
  So an admin connects a **Playwright MCP** endpoint once in Settings → External MCP and its
  browser-automation tools appear to **Claude Desktop / Claude Code / any external AI** that
  connects to the workspace MCP endpoint, alongside the build/authoring tools — a single
  unified endpoint. The namespacing (`mcpPrefix` / `namespacedToolName` in `_shared/mcp.ts`)
  is pure + unit-tested (`tests/mcp_test.ts`); setup guide: `docs/playwright-mcp.md`.
  *(Planned: per-user tokens + a member-facing UI, auto-refresh, and wiring the eval
  `orchestrator`/`loop` loops.)*
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
- **Multi-tenant release fan-out (`release-tenants.yml`):** the origin deploy workflows only touch
  ONE project on `main`, but this template runs as many tenant apps (each its own Supabase project +
  Railway frontend, all under the maintainer's own Supabase org). The frontend already fans out (each
  tenant rebuilds from the `release` branch), but migrations + edge functions did not — so a tenant
  got new frontend code calling a table/function its DB never received (`Could not find … in the
  schema cache`). `release-tenants.yml` closes that: on push to `release` (the same merge that ships
  the frontend), it fans out to every live tenant — applying pending migrations + deploying functions
  — using the SINGLE org-owner PAT (`SUPABASE_ACCESS_TOKEN`, already used for the origin), so **zero
  per-tenant secret and nothing for a tenant to do**. The tenant list comes straight from the
  **control plane's `tenants` table** (the system of record — `control-plane/`): `scripts/list-tenants.ts`
  queries it (via the Management API SQL endpoint, `CONTROL_PLANE_REF` repo variable) for
  `status in ('active','past_due')` refs, so the registry stays in sync automatically — no hand-kept
  list. `infra/tenants.json` is only an optional **canary override** (pin to one ref to roll out to a
  single tenant first; empty = all live tenants). Migrations go through the Management API SQL endpoint
  (`scripts/apply-migrations.ts` → `/database/query`), because a PAT can't fetch a project's DB password
  (so `db push --db-url` isn't an option); it reads `schema_migrations`, applies each pending file
  (version = `NNNN` prefix, matching `db push`) in a transaction, records it, then calls
  `setup_automation_cron` (0094). The pure logic (`pendingMigrations`, `parseTenantRefs`) is
  `src/lib/rollout.ts` (unit-tested). Functions deploy via `supabase functions deploy --project-ref`
  (PAT-only). `fail-fast:false` so one bad tenant never halts the fleet; `workflow_dispatch` offers a
  dry-run.
- **DB migrations on `main`:** a **GitHub Action** (`.github/workflows/deploy-migrations.yml`)
  runs `supabase db push` whenever a file under `supabase/migrations/**` changes on `main`, so new
  migrations go live automatically (the CLI's migration history makes re-runs apply only what's
  pending). It needs `SUPABASE_ACCESS_TOKEN` (the same PAT as the functions workflow) **plus**
  `SUPABASE_DB_PASSWORD` — `db push` connects straight to Postgres, so the access token alone can't
  apply migrations. Project ref defaults in the workflow, overridable via the `SUPABASE_PROJECT_REF`
  repo variable. **Each migration filename must have a unique, contiguous numeric prefix**
  (`0040_…` after `0039_…`): `db push` derives the version from the prefix, so two files sharing
  a number (e.g. two `0032_*.sql`) collide and the push is rejected. Always use the next free number.
  `src/lib/migrations.test.ts` guards this (unique prefixes) — but it only catches collisions once
  BOTH files are on `main`, so a duplicate can slip in via a rebase (your `0086` + a `0086` that
  landed while you were working); re-check the next free number right before pushing, not just when
  you create the file. **Changing a function's return type needs a DROP first:** Postgres rejects
  `create or replace function` when the `returns`/OUT signature changes (`SQLSTATE 42P13
  "cannot change return type of existing function"`), which aborts the whole `db push`. When a
  migration widens an existing function (e.g. adding a column to a `returns table (...)`), prepend
  `drop function if exists public.fn(argtypes);`. A migration that fails this way **never records as
  applied**, so its objects are missing in prod (e.g. a later `promote_to_admin` in the same file is
  never created) until fixed — and because it never applied, editing the file in place to add the
  DROP is the correct, safe fix.
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
    CollectionPicker.tsx       Shared collection FILTER: one searchable, counted
                               popover + a removable-token row (replaces the
                               per-collection chip wall on every list page)
    TodoBoards.tsx             The to-do Board/Time/Calendar/Focus views
    icons.tsx                  Inline SVG icons (no icon dependency)
  pages/                       LoginPage, ChatPage, ArtifactsPage,
                               ArtifactEditorPage, PublicArtifactPage,
                               WhiteboardsPage, WhiteboardEditorPage (Excalidraw, lazy),
                               CardBoardsPage, CardBoardEditorPage (free-form drag canvas),
                               KnowledgePage (the compiled layer: review/compiled/briefs/policy),
                               TodosPage, FilesPage, TablesPage, SkillsPage, WebhooksPage, ToolsPage,
                               AgentsPage, ApiPage, ActivityPage
    settings/                  Settings is a sidebar SECTION, one page per area:
                               ProfileSettings, ConnectClaudeSettings, ModelsSettings,
                               TimezoneSettings, EmailSettings, SlackSettings, McpSettings,
                               InviteSettings, FeatureFlagsSettings. cards.tsx holds the shared card
                               components; shell.tsx has SettingsShell/AdminGate/useIsAdmin.
  lib/
    supabase.ts                createClient<Database>(...) + chatFunctionUrl
    chat.ts                    streamChat(): SSE parser for the chat function
    todos.ts                   Pure to-do logic: filter/sort, the status lanes +
                               done/status reconciliation, due-date buckets, the
                               Focus ranking, the calendar grid (unit-tested)
    collectionPicker.ts        Pure logic behind the shared collection picker:
                               name filtering, the empty rule, the trigger label
    compiler.ts                Browser mirror of the compiler vocabulary: status tones,
                               policy round-trip, grouping, run summaries (pure, unit-tested)
    nav.ts                     Single source of truth for the sidebar (Layout,
                               GlobalSearch, and Feature flags all consume it) +
                               feature-flag filtering helpers (pure, unit-tested)
    database.types.ts          Typed schema (keep in sync with the migration)
    util.ts                    makeSlug, formatBytes, formatDate
supabase/
  migrations/                  0001 base … 0008 agents/MCP; 0012 PDF knowledge; 0014 model profiles; 0015 guardrails; 0016 email/Vault; 0019 OpenRouter provider; 0020 usage tracking; 0029 user tables (Airtable-like real Postgres tables); 0033 collections (tag/group artifacts to chat with); 0034 collection_token_stats RPC (per-collection size for the context-window meter); 0035 collections_combined_chars RPC (deduped size of several collections); 0036 mcp_servers (external MCP endpoints, Vault tokens); 0037 vault_secrets (Vault-backed team secrets vault); 0038 loop_builtins (start_loop/check_loop/list_loops); 0039 loop_stop_reason_time ('time' stop reason); 0040 authoring_builtins (create_artifact/create_collection/add_to_collection/list_collections/add_note); 0041 todos (+ collection_todos join; seeds to-do builtins); 0042 collection_files (files in collections + _file_chars sizing); 0055 files_builtins (files.tags/source columns + seeds the file CRUD builtins create_file/list_files/get_file/delete_file/add_file_to_collection); 0058 security_scans; 0059 artifact_images (public artifact-images bucket); 0060 drop_plugins; 0061 features_realtime; 0062 artifact_share_password; 0063 events (events + event_listeners + event_listener_runs; emit_event helper + DB triggers on the core tables/collection joins); 0064 messages (generalizes inbox_messages into the unified inbox + collection_inbox_messages join; seeds save_message/list_messages/add_message_to_collection); 0065 feature_flags (admin-writable workspace-wide sidebar hide/show; realtime); 0067 artifact_filing_builtins (seeds list_artifacts; create_artifact gains a `collections` array; add_to_collection accepts `artifact_title`); 0068 collection_agents (agent↔collection join; **renumbered from a colliding second 0065 that broke `db push` on main** — prod had recorded 0065=feature_flags, so the duplicate-prefix collection_agents could never apply and blocked every later migration); 0069 user_memory (per-user `user_memories` table + owner-only RLS + realtime + memory.created/updated events; seeds the remember/list_memories/update_memory/forget builtins + an always-on "User memory" prompt); 0072 evals_mcp (adds `eval_suites.collection_ids` for chat/agent grounding; the eval MCP surface — list_evals/create_eval_suite/add_eval_cases/run_eval/get_eval_run — + model-matrix + background runs need no other schema, since `eval_runs.model` already existed); 0074 whiteboards (Planner — `whiteboards` scene table + `collection_whiteboards` join + owner/workspace RLS + realtime + whiteboard.created/updated events; teaches the generic collection.item_added trigger `collection_whiteboards`; seeds the create/list/get/update/add_whiteboard_to_collection builtins); 0075 card_boards (Planner — `card_boards` cards-jsonb table + `collection_card_boards` join + owner/workspace RLS + realtime + card_board.created/updated events; teaches collection.item_added `collection_card_boards`; seeds create_card_board/list_card_boards/get_card_board/add_cards/add_card_board_to_collection); 0076 conversation_card_board (adds `conversations.card_board_id` so the Cards editor's `BoardChatPanel` gets a PERSISTENT per-board chat thread; the chat function accepts `cardBoardId` and injects that board's cardsToText); 0077 mcp_oauth; 0078 dashboard_widgets (user-composable Home-dashboard tiles — `{kind: stat|list|chart, source, spec}` owner-only rows + realtime; the app renders them by querying the source under RLS, so a customer adds widgets without forking/redeploying; seeds create_widget/list_widgets/remove_widget); 0079 chat_cancel (adds `conversations.cancel_requested_run` so the chat function can persist the assistant reply in a background `EdgeRuntime.waitUntil` task — surviving a mid-reply reload/navigation — while the Stop button still truly cancels the run via this per-run marker); 0080 agent_jobs (capability-worker queue — `agent_jobs` + `agent_job_events` tables, `claim_agent_job`/`recover_stale_agent_jobs` RPCs with FOR UPDATE SKIP LOCKED + lease recovery, agent_job.created/updated events, owner/admin RLS; seeds the create_agent_job/get_agent_job/list_agent_jobs/cancel_agent_job builtins + the capability-worker-jobs/office-document-worker/media-ffmpeg-worker skills; workers live in `workers/`; **renumbered from a colliding 0078 that clashed with main's dashboard_widgets/invite_links**); 0081 invite_links (shareable invite links — `invite_links` table + `invite_link_status`/`redeem_invite_link` anon-callable security-definer RPCs + admin-only RLS; **renumbered from a colliding second 0078 that clashed with dashboard_widgets and broke `db push` on main** — made idempotent (create-if-not-exists + drop-policy-if-exists) so re-applying against a workspace that already has the objects is a no-op); 0083 eval_tools (tool-usage evals: `eval_suites.sandbox_tools` + a `tool` target_kind; the trace-based tool assertions ride the existing eval_cases.assertions shape, no new tables; **renumbered from a colliding 0073 that clashed with main's artifact_images_private**); 0084 build_tool_builtins (seeds create_agent/list_agents/create_http_tool/list_tools/create_webhook + skill CRUD create_skill/list_skills/get_skill/update_skill/delete_skill as `is_builtin` tools so the INTERNAL assistant + agent loops can build agents/tools/webhooks/skills — the handlers moved into `_shared/builtins.ts` and the MCP server now delegates to them; per-tool admin gates re-checked in code); 0091 cron_schedules (adds `schedules.cron_expr` + `schedules.timezone` so an agent schedule can fire on a standard 5-field cron expression — e.g. the 15th or last day of the month — evaluated in its timezone; the scheduler branches next-run computation to `_shared/cron.ts`'s `nextCronRun` (croner) when `cron_expr` is set, `interval_minutes` stays the back-compat default; **renumbered from a colliding 0086 that clashed with main's 0086_hybrid_search** landed by the retrieval commits — the `migrations.test.ts` unique-prefix guard caught it); 0092 workspace_settings (admin-write/member-read/realtime KV; seeds `timezone='UTC'` — the workspace-wide clock the six agent loops inject as the current date/time and the default zone for new schedules; `_shared/timezone.ts` + `src/lib/timezone.ts` pure helpers unit-tested); 0093 table_events (per-table event sourcing — `user_tables.settings` jsonb bag + `webhooks.table_id`/`target_column` for a deterministic webhook→table target; opt-in `emit_user_table_event` AFTER INSERT trigger emits a frozen `table.<slug>_<id>` event; owner-gated `set_user_table_events`/`emit_test_table_event` RPCs); 0094 automation_cron (closes the "out-of-band cron" class — `setup_automation_cron(base_url)` idempotently (re)schedules the dispatcher + scheduler pg_cron jobs (single source of truth `_automation_cron_jobs()`), secret read at tick-time; `automation_cron_status()` drives the in-app admin health banner on Listeners; the `deploy-migrations.yml` workflow calls the RPC post-`db push` over HTTPS with a service key fetched from the Management API — so every tenant self-schedules its crons on deploy, no manual step); 0110 table_forms (public write-forms for user tables — owner opt-in `table_forms` with a column allow-list + opaque token; the public `form-submit` edge function inserts one row as the service role, enforcing allow-list/required/type/rate-limit in code so `ut_*` never grants `anon`; write-only, reads are a follow-up; pure `_shared/forms.ts` + `src/lib/forms.ts` unit-tested; **renumbered from a colliding 0109 that clashed with main's 0109_skill_usage** — the `migrations.test.ts` unique-prefix guard caught it); 0120 todos_realtime (publishes `todos` + `collection_todos` over Realtime with `replica identity full`, so a board updates live for everyone instead of diverging until someone reloads — RLS still gates the stream per subscriber, so it widens no access); 0118 todo_backlog_lane (corrects where a PERSON's to-dos land — 0116's `triage` default swept an existing backlog into one lane, contradicting its own "un-ticking lands in next because it was committed to" rule; backfills pre-0116 human-added open rows to `next` and the UI quick-add paths now insert `next`, leaving `triage` for what an agent/API/inbox files AT you); 0116 todo_status (to-do lifecycle — `todos.status` lanes + `todos.source` provenance + the `todos_sync_status` BEFORE trigger that keeps `status` and the older `done` boolean consistent whichever half a writer sets, so every pre-0116 surface keeps working; re-seeds the create_todo/list_todos/update_todo tool schemas); 0112 knowledge_compiler (the COMPILED layer — `knowledge_pages` maintained pages + `knowledge_claims` provenance + `knowledge_links` relationships + `knowledge_conflicts` review queue + `compile_runs` change briefs + `compile_policies` the per-collection trust boundary; owner/workspace RLS mirroring collections, realtime on runs/conflicts/pages, `knowledge.page_created/page_updated/conflict_detected/compiled` events; seeds the eight compiler builtins + an always-on "Knowledge compiler" prompt)
  functions/_shared/openrouter.ts  OpenRouter client (orComplete/orStream + tool/web helpers + usage) shared by all 3 loops + guardrails
  functions/_shared/usage.ts   recordUsage: writes a usage_events row per model call (all 3 loops + guardrails)
  functions/_shared/timezone.ts  resolveWorkspaceTimezone + pure currentTimeSection/formatInZone (all 6 agent loops inject the workspace-local now; unit-tested in tests/timezone_test.ts)
  functions/openrouter-balance/index.ts  Admin-only (verify_jwt: true): proxies OpenRouter GET /api/v1/key for the /usage page
  functions/_shared/builtins.ts  runBuiltin: search_documents, send_email, check_email, tables/vault tools, whiteboard tools (create/list/get/update_whiteboard), + loop tools (start_loop/check_loop/list_loops) — shared by all 3 loops
  functions/_shared/whiteboard_scene.ts  Pure sceneToText / normalizeElements / buildScene for whiteboards (unit-tested in tests/whiteboard_test.ts)
  functions/_shared/card_board.ts  Pure cardsToText / normalizeCards / buildCards for card boards (unit-tested in tests/card_board_test.ts)
  functions/_shared/compiler.ts  The knowledge compiler's pure core: the trust boundary (classifyUpdate), policy normalization, the extraction prompt, fail-closed JSON parsing, page matching, claim fingerprints, staleness, change briefs, compiled-first context (unit-tested in tests/compiler_test.ts)
  functions/_shared/compiler_tools.ts  The eight compiler builtins (compile_collection / list_knowledge_pages / get_knowledge_page / update_knowledge_page / list_conflicts / resolve_conflict / get_change_brief / set_compile_policy), shared by every agent loop and the MCP server
  functions/compile/index.ts   Compilation pass (verify_jwt: false): gather new sources -> extract -> update within the policy -> flag conflicts -> write a change brief
  functions/_shared/loops.ts   create/trigger/format helpers for the looping system, shared by the MCP server + builtins
  functions/chat/index.ts      Deno edge function: agentic tool loop, streams the model via OpenRouter (verify_jwt: true)
  functions/webhook/index.ts   Public ingest function (verify_jwt: false), runs a prompt
  functions/email-inbound/index.ts  Public inbound-email sink (verify_jwt: false), token-gated → inbox_messages (source='email')
  functions/message-inbound/index.ts  Public unified-inbox ingest (verify_jwt: false), mcp_tokens bearer → inbox_messages (any source)
  functions/event-dispatch/index.ts  Cron-ticked (verify_jwt: false, cron-secret): matches new events to event_listeners and runs their actions
  functions/_shared/events.ts  Pure matchListener/substituteEvent/describeEvent for the dispatcher (unit-tested in tests/events_test.ts)
  functions/mcp/index.ts       Public MCP server (verify_jwt: false) for an external Claude
  functions/p/index.ts         Public standalone-page server (verify_jwt: false): serves a shared HTML artifact as raw text/html
  functions/slack-events/index.ts  Public Slack Events endpoint (verify_jwt: false, HMAC-gated): @mention → collections-scoped reply in-thread
railway.json, DEPLOY.md        Deployment config + guide
```

## Database & security model

Schema lives in `supabase/migrations/` (0001 base + later migrations). Tables:
`profiles`, `conversations`, `messages`, `artifacts`, `files`, `skills`,
`allowed_emails`, `webhooks`, `webhook_events`, `tools`, `activity_log`, `agents`,
`mcp_tokens`, `model_profiles`, `guardrails`, `integrations` (Vault-backed email
config), `inbox_messages` (the unified inbox — any `source`, not just email),
`events` + `event_listeners` + `event_listener_runs` (the automation pub/sub),
`usage_events`
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
  manage invites in Settings → Invite people, two ways: **by email** (add an address to
  `allowed_emails`) or **by shareable link** (`invite_links`, migration 0081). A link is
  an opaque UUID token an admin mints and hands out (Slack/DM); the recipient opens the
  public `/join/:token` route (`JoinPage`) and signs up with their own email. The page
  validates the token via the anon-callable security-definer `invite_link_status(token)`
  RPC, then `redeem_invite_link(token, email)` (also anon-callable, security-definer)
  allowlists the entered email into `allowed_emails` so the SAME `enforce_invite_only`
  guard still gates the actual signup — the link only authorizes an email on the fly, it
  never creates the account (Supabase Auth still does). Links support optional
  `expires_at`/`max_uses` (both null = open/unlimited) and an `active` revoke switch;
  admins create/copy/revoke them in the same Settings page. `inviteLinkUrl(token)` in
  `src/lib/supabase.ts` builds the URL.

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
seeded `openai/gpt-5.6-luna`) and `utility` (cheap + fast, seeded
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
`tools` rows and runs an **agentic loop**: the OpenRouter web search server tool (for `kind = 'web'`)
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

**Never commit directly to `release`.** `release` is a release cut of `main` and only ever
receives changes by merging `main` into it (the `main → release` PR). Committing straight onto
`release` makes it diverge from `main`, which turns the next `main → release` merge into a
conflict — exactly what happened once (PR #258: commit #235 was authored on `release`, so
`FilesPage`/`HomePage`/`icons.tsx`/`CLAUDE.md` collided with main's newer versions). To cut a
release: land the work on `main`, then merge `main → release` (a clean fast-forward as long as
this rule holds). If `release` has already drifted, reconcile by merging `release` into `main`
resolving every conflict in **main's favor** (main is the superset) — that records the shared
history without changing any file on `main`, and the pending `main → release` PR becomes a clean
fast-forward again.
