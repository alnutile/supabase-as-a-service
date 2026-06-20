# Why a small business would want this

*The pitch, in plain language. For what the system is technically, see the [README](./README.md).*

## Who this is for

A **5–50 person services business** — an agency, consultancy, accounting or law
practice, a trades company — that produces documents and proposals, answers the same
client questions over and over, and wants AI working from *its own* materials without
shipping them to a third party.

But the real buyer is a **person** inside that business: the manager or owner who has
discovered that, thanks to AI, they can now do work that used to require hiring a
developer. They can pull a report from the ticket system every morning. They can turn a
messy RFP into a clean first draft. They can wire up the lead form to triage itself.
What they *can't* do is make any of that **hosted, shared with their team, and
remembered** — because the tools they're using (Claude Desktop, ChatGPT) are personal
accounts that forget everything the moment the window closes.

That's the gap this fills.

## The problem

Most small businesses today have the same three problems with AI:

1. **Their knowledge is scattered.** Past proposals, rate cards, contracts, how-we-do-things
   docs — they live in email threads, someone's Drive, and a few people's heads. Every new
   proposal, quote, or client answer starts from a blank page.
2. **AI doesn't know their business — and it's personal, not shared.** ChatGPT- and
   Claude-Desktop-style tools are per-person accounts with no shared memory. Everyone pastes
   company context in by hand, every time, and pastes company data *out* to a vendor while
   doing it. Nothing one person teaches the AI carries over to anyone else.
3. **Automation is out of reach.** "When a lead form comes in, summarize it and draft a
   reply" normally means hiring a developer, or stitching together per-seat, per-task
   subscriptions whose logic lives outside your business — not in it.

## What it is, by contrast

The fastest way to understand this is by what it's *not*. Chances are someone on your
team is already using one of these and has hit its wall:

| You're probably using… | The wall you hit | What this is instead |
| --- | --- | --- |
| **Claude Desktop / ChatGPT** | Personal, on one laptop. No team. No history that compounds. You re-paste company context every time. | The same power, but **hosted, shared, and remembered** — a team account, not a personal one. |
| **Obsidian** (the "second brain" instinct) | Too hard for most people, and it's *notes* — it stores knowledge, it doesn't act on it. | A second brain that **acts**, and that a non-technical person can actually run and share. |
| **A custom internal build / per-seat SaaS** | Either an engineering project to build and maintain, or a subscription that holds your data and charges per head. | Automation built as a **conversation**, on a foundation you own outright. |

An open-source (MIT) team workspace — an intranet — that runs on **your own Supabase
project** with a single AI assistant at the center. You deploy it once; your whole team
logs into the same workspace, with the same AI, sharing the same accumulated context.
There are no per-seat fees and no vendor holding your data.

## How to start: one win, then the next question

You don't need all of this on day one. The point is to start with **one repetitive job
you already owe someone**, and let each capability answer the next question it raises.

### Step 1 — Land one quick win

Pick the boring, weekly thing. The classic:

> *"Every morning, pull our ticket system and write the leadership report — the one I
> currently spend 40 minutes on by hand."*

Connect the assistant to your other systems (via custom tools or MCP — covered below),
describe the report you want, and it drafts it. That's the hook: a real chunk of your
week, handed back to you.

### Step 2 — "…but can I trust it enough to stop checking?"

A draft you have to re-read every time isn't automation — it's a second job. The
direction this project is built toward is **confidence through evaluation**: being able
to score and check the assistant's output against your own standard, so a proven
workflow can run *without* you hovering over it. The goal isn't "AI that writes a
report." It's "a report I trust enough to forward." *(This is where the project is
headed; see the roadmap — it's the difference between a toy and something a business
actually runs on.)*

### Step 3 — "…and my team needs this too"

The win that lives on one person's laptop is a party trick. Here it's a **shared
workspace**: the context you teach the AI, the documents you upload, and the skills you
build are available to everyone, and the things you make become **links you hand out** —
internally, to a client, or on the open web. Knowledge and automation compound across the
team instead of restarting with each person.

### Step 4 — "…now the bigger jobs"

Once the routine work is trustworthy and shared, the same machinery handles the
high-value work: drop in an RFP PDF and get a structured kickoff or a first-draft reply
in your house format; turn a spec into a quote priced like your past projects. The
staircase keeps going — you're not learning a new tool, you're asking the next question.

## What it does, from the buyer's side

### 1. It builds up *your company's* context

- **Upload your documents and the AI can search them.** Drop in past proposals, pricing
  sheets, SOPs, contracts. PDFs are automatically indexed (chunked + embedded, at no
  per-document AI cost) and the assistant can pull from them mid-conversation:
  *"What did we charge Acme for the website rebuild? Use that as the baseline."*
- **Teach it how your business works, once.** Always-on prompts let an admin write
  workspace-wide context — *"We're a 6-person design agency. Our proposals always include
  a discovery phase. Never quote hourly."* — and every chat, for every employee, starts
  from that knowledge.
- **Reusable skills.** Recurring jobs ("draft a proposal in our format", "write a status
  update for a client") become `/` commands anyone on the team can run.

The compounding effect is the point: every document uploaded and every prompt refined
makes the *next* piece of work faster, for everyone, not just the person who did it.

### 2. It turns conversations into shareable deliverables

Chat output usually dies in the chat window. Here, the assistant can turn any answer into
an **artifact** — a real document (markdown, HTML, code) with a live preview and its own
URL. Each one has a visibility switch:

- **Private** — internal only
- **Unlisted** — anyone with the link (send a proposal to a client; no account needed)
- **Public** — on the open web

So the proposal workflow is literally: chat with the assistant (which knows your past
work), say *"turn that into something I can send"*, and share the link. Files work the
same way — private storage with time-limited signed links when you want to hand something
out.

### 3. It automates without an engineering team

- **Webhooks:** every webhook gets a public URL with an attached prompt or agent. Point
  your website's lead form (or any system that can POST) at it, and the assistant
  processes each submission — summarize, classify, draft a response — with a live event
  log.
- **Agents:** a named assistant with its own instructions and its own allowed tools
  ("the proposal drafter", "the lead triager"). Built in a dashboard, not in code.
- **Schedules:** run an agent every N minutes — the morning ticket digest from Step 1, a
  recurring check.
- **Custom tools:** the assistant can call your other systems. Adding a capability is
  adding a row in a dashboard (name, description, URL) — not deploying code.
- **Forge — deploy real, deterministic functions:** when a job needs to be *exact* — a
  calculator, a unit or currency converter, a precise data transform, a
  validate-then-call-an-API step — an admin describes it in plain language and the system
  **generates a real edge function, deploys it to your project, and registers it as a
  tool**. The AI decides *when* to call it; deterministic code does the *work*, so the
  parts that must be right every time aren't left to the model's guesswork. Those
  functions plug into the same chat, agents, and webhooks as everything else.
- **MCP:** connect Claude Code or Claude Desktop to the workspace and say *"build me an
  agent that does X"* — it gets authored and pushed into your dashboard from outside. This
  is also how you bring your company's existing history and connections in: the personal
  Claude you already use becomes a way to *populate* the shared workspace.

### 4. Confidence, not just output

This is the pillar that separates a team's working tool from a personal toy. The moment
automation matters, the question stops being "can it write this?" and becomes "can I
trust it enough to stop checking?"

Part of the answer already ships. The exact work can be handed to **deterministic
functions** (see Forge above) instead of the model's best guess, and **guardrails** —
cheap, fast pre-flight checks an admin defines — screen inputs *before* the main model
runs, blocking a bad or hostile request rather than acting on it. The other half is on the
way: **evaluation** of the assistant's *output*, so a proven workflow can be promoted to
run on its own and a skill can be shared across the team with a track record behind it,
not just a hope. *(Output evaluation is in progress — see the roadmap.)*

### 5. You actually own it

- **Your data stays in your Postgres database**, protected by row-level security —
  the same boundary banks use, enforced in the database, not in app code. Private means
  private even from other employees; the workspace is invite-only by design.
- **The AI key lives only on your server.** The browser never sees it.
- **MIT licensed.** Fork it, restyle it, extend it. If you stop using it, your data is
  sitting in a standard Postgres database you control — not in an export queue at a SaaS
  vendor.

### 6. Hosting is hard — this makes it someone else's job (for free)

Getting an internal app *hosted* — with login, HTTPS, backups, and security patches —
is normally where small businesses give up or start paying: a consultant, a DevOps
hire, or a SaaS subscription that holds the data hostage. This project is built so the
hard parts are carried by managed platforms' free tiers:

- **Supabase** runs the database, authentication, file storage, realtime, and the
  server-side AI functions — patched, backed up, and TLS'd by them, owned by you.
- **A static host** (Railway is preconfigured) serves the app itself. There is no
  server you maintain, nothing to patch at 2am, no machine to outgrow.
- **Secure by architecture, not by configuration:** row-level security, invite-only
  signup, server-side keys, and time-limited share links are the defaults — you don't
  hire someone to harden it, because it ships hardened.

The result: a team can go from *nothing* to a hosted, authenticated intranet — with an
AI assistant, agents, webhooks, and file sharing — in an afternoon of copy-paste, for
roughly the cost of the AI usage alone. Sharing the things you make is the same story:
a proposal or a file becomes a link you hand out, with no "how do I give the client
access" project attached.

## A concrete day one

A small agency deploys this in an afternoon:

1. The owner signs up first (becomes admin) and invites the team.
2. They upload the last 20 proposals and the current rate card to Files. The PDFs index
   themselves in the background.
3. The admin writes one always-on prompt describing the company, its services, and its
   proposal format.
4. A new lead comes in. An account manager opens chat: *"Draft a proposal for a Shopify
   build for a 10-person retailer — price it like the Henderson project."* The assistant
   searches the uploaded proposals, drafts in the house format, and the manager says
   *"make that an artifact."*
5. They flip it to **Unlisted** and email the client the link.

Total infrastructure cost: roughly $0–25/month plus AI usage. No per-seat licenses.

## On AI cost

You can see exactly what the AI is costing you. Every model call's tokens and cost are
logged, and an admin **Usage** page shows the totals, a daily chart, and a breakdown by
model, context, and user — alongside your live OpenRouter account balance pulled straight
from the key. (OpenRouter gives you its own spend dashboard too, so the numbers are
verifiable on both ends.)

The model is a one-line setting — admins re-point it in **Settings → Models** (the
database row is the source of truth; an `OPENROUTER_MODEL` server secret is only a
fallback), so you can run a cheaper model workspace-wide whenever you want. Document
indexing for search is free regardless — embeddings run on Supabase's edge, not a paid
API. On the roadmap: smarter routing so heavyweight models handle drafting and cheaper
ones handle routine traffic.

## What it's not

It's not trying to replace your accounting system or CRM, and it's not a developer tool —
if you live in Claude Code all day, you already have what you need. This is the **shared
brain in the middle**: the place where a non-technical team's knowledge accumulates and
gets put to work, hosted and owned by you. The "second brain" people reach for Obsidian
to build — except this one is easy enough for the whole team and it *acts* on what it
knows.

## The bigger idea

This is open source the way **WordPress** is open source: download it, run it, change it,
build your whole business on top of it — no permission to ask, no per-seat fee, no vendor
sitting between you and your own data. The foundation is deliberately *friendly* — a clean
UI, sensible defaults, an afternoon to deploy — because the point is for a normal team to
actually run it, not just admire the architecture.

It's also a demonstration of how far that kind of owned, open foundation can go. Built on
managed infrastructure (Supabase for the database, auth, storage, realtime, and the
server-side AI functions) plus a focused layer of UI on top, it does things that usually
take a platform team — and all of it is readable, forkable, and yours.

And if running it yourself isn't your thing, the intent is to make it **hostable for you**:
the same project, run as a managed service, so you get the owned-data, no-lock-in
foundation with none of the setup. Use it, fork it, or have it hosted — either way the
workspace and the data are yours.

## Where this comes from

This isn't a weekend wrapper around an API. It's the third iteration of an idea the
author has been building since 2023: first as
[LaraChain → LaraLlama](https://github.com/LlmLaraHub/larallama) — chat-with-your-documents,
email ingestion, and deployable AI workflows, shipped before the big platforms offered
them — then distilled into the book [*PHP and LLMs*](https://leanpub.com/php_and_llms)
and a [video series](https://youtube.com/playlist?list=PLL8JVuiFkO9K7oEwcQo8lzijczKm7ccuS&si=Pjitnmo5-y4v1oUT)
documenting the work. The early models couldn't deliver the experience the idea needed;
today's can. This rebuild is that experience, on infrastructure you own.
