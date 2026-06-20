# Roadmap

Where this project is headed, and why.

## The thesis

AI is becoming a metered utility. As usage grows (and as frontier-token prices make
casual waste expensive), the systems that win are the ones that **squeeze the most value
out of every token**: shared context so nothing gets explained twice, the right-sized
model for each job, and clear visibility into what everything costs. A workspace that
*accumulates* context gets cheaper per task over time — the opposite of pay-per-seat
tools that start from zero every conversation.

The development sequence is deliberate: **prove it works on the best model first, then
drive the cost down and prove it keeps working.** Models run through OpenRouter, so any
model (hosted or local, OpenAI-compatible) is one admin edit away.
The roadmap below is largely about keeping the quality while shrinking the bill — and
making the savings visible.

## Now: shared knowledge (specs written, in progress)

The core promise — every piece of work makes the next one faster, *for the whole team* —
needs two changes that are fully specified and ready to build:

- **Workspace-shared documents** ([spec](./docs/tasks/shared-knowledge.md)) — uploaded
  PDFs join the team knowledge base by default, with a per-document "Only me" opt-out.
  Today knowledge is siloed per uploader; this is the fix.
- **Artifacts feed the knowledge base** ([spec](./docs/tasks/artifact-knowledge.md)) —
  proposals and docs *made in the system* get indexed on create/edit, so last week's
  proposal is context for this week's. Privacy follows the artifact's visibility:
  Private artifacts compound only for their owner.

## Next: cost — see it, cap it, shrink it

The foundation is specced: **[Model Profiles](./docs/tasks/model-profiles.md)** — named
job slots (`orchestrator`, `utility`) the workspace assigns models to, managed in
Settings. Features bind to the slot, never to a model id, so swapping in a cheaper
model is one admin edit, not a code change.

1. **Token & cost tracking.** ✅ Shipped — every model call (chat, webhook,
   scheduled agents, guardrails) writes a `usage_events` row with tokens + cost, and
   the admin-only **/usage** page shows spend (totals, daily chart, by model / context
   / user) plus the live OpenRouter account balance. "It cost us $11, here's the meter"
   is now a screenshot. (Next: per-agent attribution for chat + MCP, and CSV export.)
2. **Budgets.** A soft monthly cap per workspace: warn the admins as it approaches,
   require an admin nod to blow past it. No surprise bills.
3. **Model routing.** Opus stays as the orchestrator for interactive, high-stakes work;
   routine and unattended tasks (webhook processing, scheduled runs, classification,
   summarization) route to cheaper models like Haiku. Per-agent model selection, then
   automatic escalation: start cheap, step up only when the task demands it.
4. **Prompt caching.** Always-on prompts and tool definitions are identical on every
   call — cache them and stop paying full price to resend them.
5. **Provider abstraction.** ✅ Done — all model calls go through **OpenRouter**
   (OpenAI-compatible), so a workspace can point any profile at any model (hosted or
   local) from Settings → Models. Per-profile model ids are OpenRouter slugs.

## Next: guardrails

Webhooks accept input from the outside world by design, and agents can hold tools —
that combination needs a checkpoint. The plan
([spec](./docs/tasks/guardrails.md)) is a **Guardrails** section of the app
(admin-managed, alongside Tools and Prompts):

- A guardrail is a **separate pre-flight check by a cheap model** (e.g. Haiku), run
  *before* the main model sees the request: does this webhook payload try to redirect
  the agent? Does this message contain secrets or PII? Its verdict is returned as data
  and **enforced in code** — block the run, strip the content, or proceed with tools
  disabled — never merely pasted into the prompt as advice.
- This is intentionally *not* the always-on prompts mechanism. Always-on prompts shape
  behavior from inside the same model call, which means injected payload text can argue
  with them. A guardrail sits outside the call: no tools, no conversation, output
  parsed, decision logged to the activity feed.
- Shipping with one deterministic rule alongside the model check, because an LLM
  guardrail is a mitigation, not a boundary: **unattended runs (webhooks, schedules)
  get read-only tools unless explicitly opted in per webhook.**

This doubles as cost infrastructure: the same cheap-model pre-flight that screens a
payload can also classify it for routing (see model routing above).

## Next: the proposal workflow, finished

The pieces exist — knowledge-grounded drafting, artifacts, unlisted share links. What
turns them from features into a workflow a business runs on:

- **Artifact versions** — snapshot on share, so editing a proposal after sending it
  never silently changes what the client sees.
- **View tracking** — "your client opened the proposal" in the live activity feed
  (the realtime plumbing already exists).
- **A nicer share page** — light branding, and an accept/sign-off action.

## Later

- **One-command install.** Keep grinding installation friction down — including a
  skill/MCP flow where Claude Desktop performs the Supabase setup itself, so "deploy
  your own" stops requiring a terminal.
- **Workspace export.** One button: conversations, artifacts, and files as a portable
  archive. "You own your data" should be demonstrable, not aspirational.
- **Scanned-PDF ingestion** (vision extraction — Stage 2 of the knowledge pipeline).
- **Richer team spaces** — roles beyond admin/member, comments, shared collections.

---

Have an opinion on the ordering, or want one of these badly? Open an issue.
