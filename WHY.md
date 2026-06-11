# Why a small business would want this

*The pitch, in plain language. For what the system is technically, see the [README](./README.md).*

## The problem

Most small businesses today have the same three problems with AI:

1. **Their knowledge is scattered.** Past proposals, rate cards, contracts, how-we-do-things
   docs — they live in email threads, someone's Drive, and a few people's heads. Every new
   proposal, quote, or client answer starts from a blank page.
2. **AI doesn't know their business.** ChatGPT-style tools are per-person accounts with no
   shared memory. Everyone pastes company context in by hand, every time, and pastes company
   data *out* to a vendor while doing it.
3. **Automation is out of reach.** "When a lead form comes in, summarize it and draft a
   reply" is a Zapier-plus-engineer project, priced per seat, per task, per month.

## What this is

An open-source (MIT) team workspace — an intranet — that runs on **your own Supabase
project** with a single AI assistant at the center. You deploy it once; your whole team
logs into the same workspace, with the same AI, sharing the same accumulated context.

There are no per-seat fees and no vendor holding your data. The infrastructure is a
Supabase project (free tier to start) plus a static site host; the only metered cost is
the AI usage itself.

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
- **Schedules:** run an agent every N minutes — a morning digest, a recurring check.
- **Custom tools:** the assistant can call your other systems. Adding a capability is
  adding a row in a dashboard (name, description, URL) — not deploying code.
- **MCP:** connect Claude Code or Claude Desktop to the workspace and say *"build me an
  agent that does X"* — it gets authored and pushed into your dashboard from outside.

### 4. You actually own it

- **Your data stays in your Postgres database**, protected by row-level security —
  the same boundary banks use, enforced in the database, not in app code. Private means
  private even from other employees; the workspace is invite-only by design.
- **The AI key lives only on your server.** The browser never sees it.
- **MIT licensed.** Fork it, restyle it, extend it. If you stop using it, your data is
  sitting in a standard Postgres database you control — not in an export queue at a SaaS
  vendor.

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

The model is a one-line server setting (`ANTHROPIC_MODEL`), so you can already run a
cheaper Claude model workspace-wide. Document indexing for search is free regardless —
embeddings run on Supabase's edge, not a paid API. On the roadmap: smarter routing so
heavyweight models handle drafting and cheaper ones handle routine traffic, plus support
for additional providers.

## Who it's for

A good fit if you're a **5–50 person services business** — agency, consultancy,
accounting/law practice, trades company — that produces documents and proposals, answers
the same client questions repeatedly, and wants AI working from *your* materials without
shipping them to a third party. You need one person comfortable following a deploy guide
(or an afternoon with an AI coding assistant) to set it up.

It's not trying to replace your accounting system or CRM. It's the shared brain in the
middle: the place where your company's knowledge accumulates and gets put to work.
