# Task: Navigation-resilient chat streaming (don't lose live state when you move around)

## Context

`ChatPage` (`src/pages/ChatPage.tsx`) is a route element (`src/App.tsx`). All streaming
state lives in its local React state — `streaming`, `sending`, and the running
`submit()` / `runSkill()` closures that call `streamChat()` (`src/lib/chat.ts`) and then
persist the assistant message client-side **after** the stream completes
(`insertMessage(convId, 'assistant', …)`).

**The problem:** the moment the user navigates to an artifact, Files, or any other page,
React unmounts `ChatPage`. The in-flight request keeps running (single-page navigation
doesn't abort `fetch`), so the *final* answer still lands in Postgres and reappears over
Realtime — but the **live token-by-token view is gone** while away and does not resume,
because the deltas update an unmounted component. Returning mid-stream shows nothing
until the answer pops in complete.

**The goal:** the active stream is owned **above** the router, so navigating away and
back keeps it visibly streaming, and the user can leave a long research run going,
look at an artifact, and come back to find it still live and accumulating.

**Scope boundary:** this task covers **in-app navigation** resilience (the described
scenario). Surviving a *hard refresh / tab close / crash* mid-stream is a separate,
larger change — see "Follow-up (do not build now)."

## Design decisions (already made — don't relitigate)

- **Lift active streaming into an app-level provider**, not per-page state. A
  `ChatStreamProvider` mounted above the routes (around `<Layout/>` / the protected
  app in `src/App.tsx`, so it does **not** unmount on route changes) owns the running
  streams and their accumulating text.
- **Keyed by conversation id.** The provider tracks one active stream per conversation
  (a `Map<conversationId, StreamState>`), so returning to `/chat/:id` re-attaches to
  the right buffer. A brand-new conversation (created mid-send) keys by the id returned
  from `ensureConversation`.
- **The provider owns execution and persistence**, not the page. Moving `submit()` and
  `runSkill()` (and the post-stream `materializeArtifacts` + `insertMessage` +
  conversation-touch) into the provider means the finishing logic runs in a component
  that doesn't unmount on navigation — so persistence is reliable even as the user
  moves around, and the no-op-on-unmounted-component warnings go away.
- **`ChatPage` becomes a consumer.** It reads `messages` / live `streaming` text /
  `sending` for the current conversation from the provider and renders them; it no
  longer holds the stream itself. Keep the existing UI exactly as-is visually.
- **Single in-flight stream per conversation.** Starting a send while that
  conversation already has an active stream is prevented (same as today's `sending`
  guard), but *other* conversations may stream independently.

## Requirements

### 1. `src/contexts/ChatStreamContext.tsx` (new)

- A provider holding, per conversation id: `streamingText: string | null`,
  `sending: boolean`, and the abort handle for the running request.
- Expose via context:
  - `startStream(convId, history, options)` — runs `streamChat`, appends deltas to that
    conversation's `streamingText`, and on completion runs the existing finish sequence
    (`materializeArtifacts`, persist assistant message, touch conversation). Mirrors
    today's `submit()` tail exactly — same artifact-materialization regex behavior, same
    DB writes — just relocated.
  - `getStream(convId)` → `{ streamingText, sending }` for the page to render.
  - `stopStream(convId)` — abort via an `AbortController` passed to
    `streamChat(..., { signal })` (the option already exists in `lib/chat.ts`); used by
    a "Stop" affordance and on explicit new-chat.
- The provider does **not** subscribe to Realtime or own the message list load — that
  stays in `ChatPage` (the existing load + Realtime subscription keyed by
  conversationId is correct and de-dupes via `seen`). The provider only owns the
  *in-flight* stream and the write that ends it. Coordinate the `seen`/optimistic-insert
  de-dupe so the provider's assistant insert and the page's Realtime echo don't
  double-render (today `insertMessage` adds to `seen` and to local `messages`; with the
  page owning the list, have the provider's completion notify the page, or simplest:
  let the page's existing Realtime + initial-load path be the single source of rendered
  messages and have the provider only insert to the DB, not to a local list).

### 2. `src/App.tsx`

- Wrap the authenticated app (the `ProtectedRoute`/`Layout` subtree) in
  `<ChatStreamProvider>` so it persists across all in-app route changes. Do not wrap the
  public routes.

### 3. `src/pages/ChatPage.tsx`

- Remove local `streaming` / `sending` state and the bodies of `submit` / `runSkill`
  that handle the stream; call the provider's `startStream` instead, reading
  `getStream(conversationId)` for render.
- Keep: conversation list load, message load + Realtime subscription, attachment
  upload, the skill menu, scroll-to-bottom, and all markup. The streaming bubble now
  renders the provider's `streamingText` for the active conversation.
- When returning to a `/chat/:id` whose stream is still active in the provider, the
  live text must render immediately and continue updating.
- Add a small **Stop** control while a stream is active (calls `stopStream`) — minor,
  but it's the natural home now that streams outlive the page.

### 4. Verify the other entry points still work

- `?run=1` agent auto-kickoff and the `?agent=` prompt layering must still work (they
  now call the provider). The agent/skill `options` (`system`, `replaceSystem`,
  `toolIds`) pass straight through to `startStream`.

## Acceptance criteria

1. Start a chat that triggers a long (e.g. tool-using / research) response. While it's
   streaming, navigate to Artifacts, open one, then return to the chat — the response is
   **still visibly streaming**, text continuing to accumulate, not frozen and not
   blank-until-done.
2. Upload a file on the Files page mid-stream, return to chat — stream intact.
3. The completed assistant message persists exactly once (no duplicate from the
   Realtime echo), with artifact blocks materialized into links as before.
4. Starting a second send in the same conversation while one is in flight is blocked,
   as today; a different conversation can stream independently.
5. No "state update on an unmounted component" warnings from chat in the console when
   navigating away mid-stream.
6. The Stop control aborts the active stream cleanly (no persisted partial assistant
   message, no thrown error surfaced to the user).
7. `npm run build` and `npm run lint` pass.

## Follow-up (do not build now — note in ROADMAP)

**Durable streams across refresh/crash.** Today the assistant message is only written
*by the client after the stream finishes*, so a hard refresh, tab close, or network
drop mid-stream loses the answer entirely. The durable fix is to make the **edge
function** persist the assistant message (and materialize artifacts) server-side when
the stream ends, with the client relying on Realtime for the final row — so the answer
survives even if the client goes away. That touches the chat function, the streaming
protocol, and moves artifact materialization server-side; it's a separate task. This
task deliberately delivers only in-app-navigation resilience.

## Constraints

- No visual/UX regression — same chat UI, same artifact links, same Realtime de-dupe
  behavior. This is a state-ownership move, not a redesign.
- Keep `streamChat`'s SSE contract and signature unchanged (just actually pass a
  `signal`).
- Don't introduce a second source of truth for the message list — the page's load +
  Realtime stays authoritative for *persisted* messages; the provider owns only the
  *in-flight* text and the terminal write.
