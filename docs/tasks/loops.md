# Task: Loops — goal-directed agent runs that self-correct on measured feedback and stop at a price cap

## Context

Today an agent run is **one-shot or short**: chat and the three agent loops
(`chat`, `webhook`, `scheduler`) run the model → tools → model cycle, but only up to a
small fixed bound (`MAX_TOOL_TURNS = 8` in `supabase/functions/chat/index.ts:32`) and
with **no notion of a goal, a score, or a budget**. The model decides when it's "done"
and we take whatever it produced. There is no objective signal that grounds the run, and
nothing stops a run that keeps spending money.

This task adds **Loops**: a goal-directed, self-correcting agent run that iterates against
a *measured* feedback signal and terminates on explicit stopping criteria — including a
**hard dollar budget**.

### Where the idea comes from

The pattern is **COMPILOT** ("Agentic Auto-Scheduling: An Experimental Study of LLM-Guided
Loop Optimization", Merouani, Kara Bernou & Baghdadi, NYU Abu Dhabi, PACT 2025 —
arXiv:2511.00592). COMPILOT optimizes loop nests by putting an off-the-shelf LLM in a
**closed loop with a compiler**:

1. **Context init** — brief the agent on the goal and give it a *baseline measurement*.
2. **Iterative phase** — the agent proposes an action; the environment (their compiler)
   executes it and returns **concrete, measured feedback** (was it legal? what speedup?);
   the feedback is appended to the agent's working memory; the agent refines and proposes
   again. Repeat.
3. **Stop** — when the agent issues a "no further transformations" signal *or* a
   predefined iteration limit `T` is reached. Keep the **best-scoring** variant seen.
4. **Multi-run (best-of-K)** — optionally restart the whole dialogue from scratch `K`
   times and keep the best, to escape local optima.

COMPILOT's reported result: geometric-mean **2.66×** speedup single-run, **3.54×**
best-of-5, with off-the-shelf models and *no fine-tuning* — purely from grounding the LLM
in real measurements inside a loop. The lesson that transfers here: **a loop grounded by
an objective score beats a one-shot answer**, as long as the loop has disciplined
stopping criteria so it doesn't run forever (or overspend).

This generalizes their "LLM ↔ compiler" loop to "agent ↔ any tool that returns a score."

## The idea in one paragraph

A **loop** binds an existing `agents` row to (a) a **goal**, (b) a **feedback tool** that
returns a numeric score for the agent's current candidate, and (c) **stopping criteria**.
A new **loop runner** drives the cycle: the agent proposes a candidate → the feedback tool
scores it → the score + the agent's running history feed the next iteration → repeat. The
runner tracks the **best-scoring candidate** and halts the moment any stop condition fires.
The headline stop condition is a **price cap**: every model call already returns its real
cost (`usage_events.cost` via `recordUsage()`), so the runner sums cost across iterations
and stops hard when it crosses `budget_usd`.

This is deliberately a thin layer over machinery that already exists — it reuses agents,
the tool loop, `usage`/`recordUsage`, and (for triggering) `schedules`. It is **not** a new
model integration.

## Design decisions (already made — don't relitigate)

- **A loop reuses an agent.** A loop does not re-implement prompting or tool execution; it
  points at an `agents` row (`agent_id`) for the system prompt + `tool_ids`, and adds the
  loop control on top. One agent can back many loops.
- **Feedback is a tool that returns a score, not a model self-grade.** The loop is grounded
  by an objective signal. The `feedback_tool_id` is an ordinary `tools` row (`kind='http'`,
  typically a Forge function or an eval) whose response includes a numeric `score` (higher
  is better) and an optional human-readable `detail` that is fed back into the dialogue —
  exactly COMPILOT's "speedup + message" feedback. If no feedback tool is configured, the
  loop degrades to "iterate until the agent says done / limits hit" with no best-of scoring
  (still useful, e.g. a refine-a-draft loop).
- **Stopping criteria — a loop stops when ANY of these is true (checked every iteration):**
  1. **Budget exceeded** — `cost_spent >= budget_usd`. **Fail-closed**: this is checked
     *before* each iteration's model call, and if the cost of a call can't be read we treat
     it as having spent the cap (better to stop than to overspend silently).
  2. **Iteration cap** — `iteration >= max_iterations`.
  3. **Agent converged** — the agent emits the done signal (the loop's analogue of
     `no_further_transformations`); we give it a built-in `loop_done` no-op tool to call,
     so "done" is an explicit, parseable action, not prose we have to sniff.
  4. **Target reached** *(optional)* — `target_score` set and best score ≥ it.
  Whichever fires first wins; the run records `stop_reason` ∈
  `{budget, max_iterations, converged, target_reached, error}`.
- **Best-of-K is a later toggle, not v1.** v1 ships single-run (`K=1`). The schema leaves
  room for `runs` (K) but the runner only does one pass. (COMPILOT's best-of-5 is where the
  big gains came from, so this is the obvious follow-up — note it, don't build it yet.)
- **Triggering reuses `schedules`.** A loop can be kicked manually (a "Run" button), or on
  an interval by pointing a `schedules` row at it. No new cron machinery.
- **The price cap is per-run, in USD.** It is *not* the workspace monthly budget (ROADMAP
  item 2) — that's a separate, complementary cap. A loop's `budget_usd` is the ceiling for
  a *single* run, so an expensive feedback loop can't blow the whole month in one go.

## Requirements

### 1. Schema (new migration, next number in `supabase/migrations/`)

```sql
-- loops: a goal-directed run config layered on an agent
create table public.loops (
  id              uuid primary key default gen_random_uuid(),
  owner_id        uuid not null references auth.users(id) on delete cascade,
  name            text not null,
  goal            text not null,                       -- the objective, injected into context init
  agent_id        uuid not null references public.agents(id) on delete cascade,
  feedback_tool_id uuid references public.tools(id) on delete set null,  -- returns {score, detail}
  max_iterations  int  not null default 10 check (max_iterations between 1 and 100),
  budget_usd      numeric(10,4) not null default 1.0 check (budget_usd > 0),  -- hard per-run cap
  target_score    numeric,                             -- optional early-success threshold
  visibility      visibility not null default 'private',
  created_at      timestamptz not null default now()
);

-- loop_runs: one row per execution; the audit + live-progress record
create table public.loop_runs (
  id            uuid primary key default gen_random_uuid(),
  loop_id       uuid not null references public.loops(id) on delete cascade,
  status        text not null default 'running',       -- running | done | error
  stop_reason   text,                                  -- budget | max_iterations | converged | target_reached | error
  iterations    int  not null default 0,
  cost_spent    numeric(10,4) not null default 0,      -- running sum of usage.cost
  best_score    numeric,
  best_output   text,                                  -- the best candidate seen
  transcript    jsonb not null default '[]',           -- [{iteration, action, score, detail, cost}] for the UI
  started_at    timestamptz not null default now(),
  ended_at      timestamptz
);
```

RLS mirrors the existing owner-or-workspace pattern (`agents`/`tools`): authenticated
SELECT for owner / workspace-visible / admin; writes by owner or admin; `loop_runs`
readable by whoever can read the parent loop, written only by the service role (the
runner). Add both tables to `database.types.ts` (`npm run gen:types`).

### 2. The loop runner (new edge function `supabase/functions/loop/index.ts`, `verify_jwt: true`)

POST `{ loop_id }`. The runner:

1. Loads the loop, its agent (prompt + `tool_ids`), and the feedback tool.
2. Inserts a `loop_runs` row (`running`).
3. **Context init** (COMPILOT phase 1): builds the system prompt = agent instructions +
   the loop's `goal` + an explanation of the loop protocol (you will propose a candidate,
   it will be scored, refine using the score; call `loop_done` when no further improvement
   is likely).
4. **Iterate** up to `max_iterations`:
   - **Budget gate first**: if `cost_spent >= budget_usd`, stop (`stop_reason='budget'`).
   - Run one agent turn through the **existing tool loop** (reuse the loop in
     `chat/index.ts` — factor the model→tools→model cycle into a shared helper if needed so
     `loop` and `chat` don't duplicate it).
   - After each model call, add `result.usage.cost` to `cost_spent` and call `recordUsage`
     with `context: 'loop'` (extend the `Context` union in
     `supabase/functions/_shared/usage.ts`).
   - Take the agent's candidate, POST it to the feedback tool, read `{score, detail}`,
     append `detail` to the dialogue as the next observation, update `best_score` /
     `best_output` if improved, push a `transcript` entry.
   - If the agent called `loop_done` → stop (`converged`). If `target_score` set and
     `best_score >= target_score` → stop (`target_reached`).
5. Finalize the `loop_runs` row (`done`, `stop_reason`, `ended_at`, best result) and write
   an `activity_log` entry (`loop.completed` / `loop.budget_capped` / `loop.error`).

Guardrails: run the existing `runGuardrails` pre-flight on the loop's goal/input like the
other loops do, so an untrusted-triggered loop is screened.

### 3. The `loop_done` built-in (in `supabase/functions/_shared/builtins.ts`)

A no-op tool the agent calls to signal convergence — so "done" is an explicit action the
runner can detect, not prose. Seeded `is_builtin`, available to loop runs only.

### 4. UI — `LoopsPage` (route `/loops`, sidebar, any member)

- List/create loops: name, goal, pick agent, pick feedback tool, set **max iterations** and
  **budget ($)**, optional target score.
- A loop detail view with a **Run** button and a **live transcript** of the current/last
  run: per-iteration score, the running **cost meter vs. budget** (a progress bar that
  turns red as it approaches the cap), and the `stop_reason` when it ends. Subscribe to
  `loop_runs` over Realtime for live updates (same pattern as `WebhooksPage` →
  `webhook_events`).
- Surface "best result" prominently (the COMPILOT "keep the best variant" idea).

### 5. Wire-ups

- Extend `usage.ts` `Context` union with `'loop'`; `/usage` then shows loop spend for free.
- Let a `schedules` row target a loop (add `loop_id` alongside the existing agent target) so
  loops can run on a cron tick.
- Add the new function to the deploy allow-list (`CORE_SLUGS` in the Forge deploy path /
  the `deploy-functions.yml` Action covers `supabase/functions/**` automatically).

## Security / RLS

- RLS on `loops` / `loop_runs` mirrors `agents`/`tools` exactly — no new trust model.
- The runner runs with the service role but **re-enforces the caller's identity** for the
  feedback tool call and respects the agent's `tool_ids` scoping (same discipline as the
  shared builtins).
- The **budget gate is fail-closed**: an unreadable cost counts as spending the cap. A loop
  can never iterate without a known, bounded cost.
- Webhook-triggered loops inherit the existing `allow_tools` / guardrail gates.

## Why this is worth doing

- It turns the workspace's agents from "answer once" into "keep working until it's good
  enough or it hits the money cap" — the COMPILOT result says that grounding-in-a-loop is
  where the quality comes from.
- The price cap makes long agentic runs **safe to hand to non-engineers**: "spend up to $2
  trying to get this right, then stop" is a control a workspace admin actually understands.
- It reuses ~everything (agents, tool loop, usage accounting, schedules) — most of the work
  is the runner's control flow and the Loops UI, not new infrastructure.

## Open questions / follow-ups (not in v1)

- **Best-of-K** (`runs > 1`): restart from scratch K times, keep the global best — this is
  where COMPILOT's biggest gains came from. Schema already reserves room.
- **Premature-stop nudge:** COMPILOT found LLMs stop too early; the runner could re-prompt
  "keep exploring" once before honoring `loop_done`, behind a flag.
- **Workspace monthly budget (ROADMAP #2):** the per-run cap here is complementary; later,
  check both (run cap *and* remaining monthly budget) before each iteration.
- **Non-numeric feedback:** allow an LLM-judge eval (you already have evals, migrations
  0025/0026) as the feedback source for goals without a crisp numeric score.
