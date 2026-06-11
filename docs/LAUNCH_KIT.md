# Launch kit — week one

Ready-to-use assets for the first week of posting. `[NAME]` = the product name —
**pick it before posting anything** (see checklist). Voice throughout: builder showing
what's possible, never vendor selling.

The one rule when explaining feels hard: **a post shows one moment; only the essay and
the README explain the system.** If a post needs a second screenshot, it's two posts.

---

## Tonight's checklist (before the first post)

1. **Pick the name** and update the README header. Everything below needs it.
2. **Stage demo data** in your deployed workspace (see shot list below) — fake agency,
   realistic documents. Never screenshot an empty app.
3. **Capture the shot list** (30 min) and **record the 90-second proposal demo** once,
   well. Every channel reuses these for weeks.
4. Put the demo GIF at the top of the README — the repo *is* the landing page
   tomorrow.

---

## LinkedIn — week 1 (post mid-morning, link in first comment, reply to every comment)

### Day 1 (Mon) — the origin hook

> Three years ago I built an AI product too early.
>
> It was called LaraLlama: document collections you could chat with, email and web
> ingestion, multi-model workflows, outputs you could deploy as chatbots and APIs. I
> started it in 2023 — before "agents" was a product category.
>
> Sound familiar? It's more or less what the major AI platforms shipped over the next
> two years as projects, connectors, and agent builders.
>
> I archived it last year. The idea was right. The 2023 models couldn't deliver it —
> mediocre answers, unreliable agents, and no amount of product work fixes the
> substrate.
>
> The substrate is fixed now.
>
> So I'm back, building the next version in the open: [NAME], an open-source AI
> intranet for small teams. Your team's AI, on your own database. It learns your
> business from your documents, the whole team shares it, and you own every byte.
>
> This week I'll start showing what it can do. Today is just the thesis.
>
> Repo in the comments if you want to skip ahead.

*(First comment: repo link + "MIT licensed — fork it, run it, it's yours.")*

### Day 2 (Wed) — the demo moment (attach the screenshot or 20s clip)

> Your agency has written 200 proposals. Your AI has read none of them.
>
> That's the gap [NAME] closes. The loop:
>
> 1. Upload past proposals + your rate card. PDFs index automatically — the
>    embeddings cost nothing.
> 2. Ask: "Draft a proposal for a Shopify build for a 10-person retailer. Price it
>    like the Henderson project."
> 3. It searches *your* documents and drafts in *your* format with *your* pricing.
> 4. Say "make that an artifact" → you get a link to send the client. No login on
>    their end.
>
> The part that matters: next month's proposal is drafted with this month's as
> context. The system compounds — it gets better the more your team uses it.
>
> Screenshot below is the real thing, running on a free-tier database.

### Day 3 (Fri) — the builders' post

> Your team doesn't need another AI subscription. It needs a database.
>
> The whole stack of [NAME]:
>
> — React SPA, MIT licensed
> — Supabase: Postgres, auth, realtime, storage, edge functions
> — Row-level security is the boundary — the browser only ever holds the anon key
> — PDFs → pgvector, embedded free at the edge
> — Agents, webhooks, scheduled jobs, even the AI's tools: rows in tables, not
>    deployments
> — The Anthropic key never leaves the server
>
> No per-seat pricing because there's no vendor in the middle. Your data sits in your
> Postgres. Stop using it tomorrow and you keep everything.
>
> The labs will keep shipping incredible capability layers — and this product gets
> better every time they do. I'm building the layer they structurally can't: the one
> you own.
>
> Architecture write-up coming this weekend. Repo in comments.

---

## Substack essay 1 — "I built AI agents two years too early"

Publish Tue/Wed. ~1,200 words. Opening:

> In 2023 I started building a product where you'd pour your documents, email, and web
> pages into collections, chat with them, wire workflows around them, and deploy the
> results as bots and APIs. I called it LaraLlama. If that sounds like every AI
> platform announcement of the last two years — yes. That's the point of this story.

Beats:

1. What LaraLlama was (screenshots of the archived repo — receipts matter).
2. What happened: the platforms shipped the same shapes with a thousand times the
   resources. The honest autopsy: I built horizontal capability, which is exactly the
   layer model providers always commoditize — and 2023 models couldn't cash the checks
   the vision wrote anyway.
3. What's different now: the substrate works, and I'm not building on the layer the
   labs eat. I'm building what they structurally won't: software you own, on your own
   database, MIT licensed, shaped for small teams instead of everyone.
4. What [NAME] is, in one paragraph + the demo video embed.
5. The plan: building in the open, weekly. Star the repo / subscribe to follow along.

---

## YouTube

### Video 1 (8–12 min): "I built AI agents two years too early. I'm trying again — in public."

- **Cold open (30s):** archived LaraLlama repo on screen. "165 stars, 797 commits,
  archived. This was my AI agents product. I started it in 2023 — two years before
  the platforms made it a category. Let me show you what I got right, what ran me
  over, and what I'm doing differently."
- **Act 1 (2 min):** LaraLlama tour — collections, ingestion, workflows. Then the
  timeline: what the platforms shipped after.
- **Act 2 (1 min):** the autopsy (substrate + wrong layer).
- **Act 3 (4–5 min):** [NAME] tour — login, chat that knows the uploaded proposals,
  the artifact → unlisted link flow, the activity feed, agents dashboard, and the MCP
  moment (Claude Desktop building an agent *into* the workspace — your most unique 60
  seconds; nobody else has this shot).
- **Close (1 min):** the thesis — own your AI layer — the roadmap in 3 bullets, repo
  link, "I'll be shipping and posting weekly."

### Short 1 (60–90s): the proposal demo
Vertical cut of the same recording: question → search → draft → artifact → unlisted
link → "runs on a free database, the code's free too, link in description."

---

## Screenshot / recording shot list

**Stage first.** Fake agency ("Coastal Web Studio" or similar), 2 users, realistic
documents. Browser: clean profile, no bookmarks bar, ~1440px wide, light theme. The
AI's answers must be real — run the actual prompts and let it actually search.

| # | Shot | Staging |
| --- | --- | --- |
| 1 | Chat answering a pricing question, citing uploaded docs | Files: `Henderson_Proposal.pdf`, `Rate_Card_2026.pdf`, 3–4 more, all showing "✓ Indexed". Ask the Henderson pricing question for real. |
| 2 | The artifact moment | Same chat: "turn that into something I can send" → artifact link appears inline. |
| 3 | Artifact editor + visibility control | The drafted proposal, Private/Unlisted/Public toggle visible, copyable link. |
| 4 | The client's view | `/share/a/:slug` in an incognito window — clean doc, no app chrome. |
| 5 | Files page | The PDF list with indexed badges — the "knowledge base" shot. |
| 6 | Activity feed | A live mix: webhook event, document indexed, artifact created, tool call. |
| 7 | Webhooks master–detail | A "Lead intake" webhook with 3–4 processed events in the log. |
| 8 | Agents dashboard | 2–3 agents ("Proposal Drafter", "Lead Triage") with tools attached. |
| 9 | Settings → Connect Claude | The MCP token screen — pairs with the video's MCP moment. |
| 10 | **The 90s recording** | Shots 1→4 as one continuous take. This is the master asset. |

---

## Image-generation prompts

Real screenshots beat illustrations for trust — use these only for the OG/banner image,
the Substack header, and diagrams. Style anchors match the app (Tailwind sky/emerald).

**OG / repo banner:**
> Minimal flat vector illustration, wide banner: five small diverse figures around one
> glowing database cylinder on a table, thin connection lines from each person to the
> database, soft sky-blue (#38BDF8) and emerald (#3FCF8E) accents on a clean white
> background, generous negative space at the top for a headline, modern developer-tool
> aesthetic, no text, no logos.

**"Silos vs shared brain" (day 2 / essay diagram):**
> Two-panel minimal flat vector diagram. Left panel: five gray figures, each facing a
> separate small chat bubble, disconnected, scattered. Right panel: the same five
> figures connected by clean thin lines to a single glowing emerald database cylinder
> in the center. White background, flat design, sky-blue and emerald accents, no text.

**"You own it" (day 3):**
> Minimal flat vector illustration: a small house-shaped outline containing a database
> cylinder and a subtle sparkle/AI glyph, a keyring with a single key beside it, white
> background, sky-blue and emerald palette, generous whitespace, no text.

**Substack header (origin essay):**
> Minimal flat vector illustration, wide: a faded, grayed-out small rocket lying on the
> ground on the left; on the right the same rocket rebuilt, upright, in vivid sky-blue
> and emerald, on a launch stand; clean white background, subtle, optimistic, no text.

For architecture diagrams, don't use image models — recreate the README's ASCII
"How it fits together" in Excalidraw and screenshot it; hand-drawn-style technical
diagrams read as authentic and are easy to update.
