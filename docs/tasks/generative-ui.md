# Task: Richer chat UI via catalog-constrained generative UI (json-render)

## Context

Chat replies render as markdown (`src/components/Markdown.tsx`) plus the `:::artifact`
protocol that `ChatPage` materializes into share links. That's good for prose, weak for
*structured* output — comparisons, option cards, checklists, key/value summaries, a
proposal preview — which currently come out as plain markdown tables or bullet lists.

[json-render](https://github.com/vercel-labs/json-render) is a generative-UI framework:
the model emits JSON constrained to a **component catalog you define** (props validated
with Zod), and a renderer turns it into UI. Because the model can only use components in
the catalog, it can't inject arbitrary markup — this is safer than the current
HTML-artifact path and fits the workspace's guardrails philosophy.

**The goal:** an **opt-in "rich card" output mode** for chat that renders a constrained
component catalog, *alongside* (not replacing) markdown. Markdown stays the default;
rich UI is an enhancement for structured answers.

## Design decisions (already made — don't relitigate)

- **Markdown stays the default.** Do not remove or route around `Markdown.tsx`. Most
  replies should remain plain markdown. Rich UI is additive.
- **Use the framework-agnostic React renderer**, not `@json-render/next` — this app is
  Vite + React, not Next.js.
- **The catalog is small, safe, and presentational** in v1. No components that perform
  actions, navigate, fetch, or take freeform HTML. Start with: `Card`, `Stack`,
  `KeyValue` (label/value rows), `Badge`, `Callout` (info/warn/success), `Checklist`,
  `Comparison` (columns of features), and `LinkButton` (an *internal* link to an
  existing in-app route or an artifact share URL only — validated, no arbitrary href).
- **The model opts in by emitting a fenced block**, mirroring the existing `:::artifact`
  convention — e.g. a ` ```ui ` code fence (or `:::ui … :::`) containing json-render
  JSON. Anything outside the block is normal markdown. This keeps one streaming text
  channel and avoids changing the SSE protocol or the edge function.
- **Validate before render, fail soft.** Parse the block, validate against the catalog's
  Zod schema; on any validation failure render the raw JSON as a normal fenced code
  block (never throw, never render unvalidated input). Partial/streaming JSON simply
  doesn't render until the block closes — show the surrounding markdown meanwhile.
- **Evaluate maturity first.** json-render is an early vercel-labs project. Before wiring
  it in, the implementer should confirm the React renderer's published package, version,
  and bundle size are acceptable; if it's not production-ready, implement the same
  pattern with a hand-rolled tiny renderer over the same Zod catalog (the catalog +
  fenced-block + validate-then-render design is the durable part; the library is
  swappable).

## Requirements

### 1. Catalog (`src/lib/uiCatalog.ts` or similar)

- Define the component catalog with Zod prop schemas for the components listed above.
- Export both the runtime renderer mapping (catalog component → React component, styled
  with the app's Tailwind tokens so it matches the existing UI) and a compact
  description of the catalog suitable for a system prompt.

### 2. Renderer (`src/components/GenerativeUI.tsx`)

- Given a validated json-render document, render it with the React adapter (or the
  hand-rolled fallback). Presentational only.
- `LinkButton` hrefs must be validated to internal routes (`/artifacts/…`, `/chat/…`,
  etc.) or share URLs; reject anything else (render as disabled/plain text).

### 3. Chat integration (`src/pages/ChatPage.tsx` / `Markdown.tsx`)

- Detect the ` ```ui ` (or `:::ui`) block(s) in assistant message content. Split content
  into markdown segments and UI segments; render markdown via `Markdown`, UI via
  `GenerativeUI`. Keep ordering. This runs in `MessageBubble` for both persisted and
  streaming messages (during stream, an unclosed UI block stays hidden/falls back to a
  subtle "rendering…" until it closes).
- Persisted message content is unchanged in the DB (the raw block is stored), so this is
  purely a render-time enhancement and historic messages keep working.

### 4. Teach the model (a seeded always-on prompt or catalog doc)

- Add a small workspace prompt (the `skills` always-on mechanism, `auto_apply = true`,
  `is_builtin`) describing when to use a `ui` block and the available components +
  props, with one example. Keep it short; the model should reach for it only when output
  is genuinely structured, and otherwise write markdown.

### 5. Docs

- README: one bullet under the chat feature ("structured answers can render as compact
  cards, not just markdown — constrained to a safe component catalog").
- CLAUDE.md: a short paragraph on the catalog, the `ui` fenced-block convention, and the
  validate-then-render / fail-soft rule.

## Acceptance criteria

1. A reply containing a valid `ui` block renders as styled cards inline, with
   surrounding markdown rendered normally and in order.
2. A reply with a malformed/over-spec `ui` block renders the raw JSON as a code block —
   no crash, no blank message, no unvalidated component rendered.
3. A `LinkButton` with a non-internal/non-share href does not produce a live external
   link.
4. Plain-markdown replies (the majority) render exactly as before — no regression.
5. Streaming a reply whose `ui` block is still open does not flash broken UI; it renders
   once the block closes (or remains markdown if it never does).
6. Historic messages stored before this change still render.
7. `npm run build` and `npm run lint` pass.

## Out of scope (do not build now)

Action/interactive components (buttons that mutate data, forms that submit), generative
UI in webhook/agent outputs, replacing the `:::artifact` protocol, rendering generative
UI on the public share page, and multi-framework catalogs. Presentational chat cards
only.

## Constraints

- Never render model output that hasn't passed catalog validation. The catalog is the
  security boundary for this feature — same principle as guardrails and tools-as-data.
- No SSE/protocol/edge-function changes — this is entirely client-side rendering of text
  the model already streams.
- Keep markdown the default and the fallback; this feature must degrade to plain text
  cleanly if the library is removed.
