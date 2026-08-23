# The knowledge compiler

Turning the workspace from **storage you search** into **understanding that is
maintained**.

## The problem it solves

Every ingredient was already here: files, links, messages, meeting notes,
collections, terminology, artifacts, agents. But the default flow was:

> add information → search for it later → generate an answer

Which means the model re-interprets raw documents on every single question.
Nothing accumulates. Context has to be re-explained. Two documents can disagree
for months and nobody finds out.

The compiler changes the flow to:

> add information → interpret it → link it → update existing knowledge → flag
> conflicts → produce a brief

The distinction that everything else follows from: **a raw file is no longer an
answer. It is evidence.** The answer lives on a compiled page, and every compiled
claim keeps a pointer back to the evidence it came from.

## The three layers

```
raw/                     already existed — unchanged
  files, links, inbox messages, meeting notes, artifacts, to-dos

compiled/                new — knowledge_pages
  concepts, decisions, processes, people, projects,
  terminology, principles, open questions, profiles

outputs/                 already existed — unchanged
  artifacts: plans, articles, proposals, reports
```

Compiled pages are written as durable reference prose describing *what is
currently true*, with evidence cited inline — not as a summary of "what this
document said".

## The pipeline

```
Capture              a file/link/message lands in a collection
  ↓
Gather               sources added since the last pass
  ↓
Extract              claims, concepts, decisions, conflicts  (one model call)
  ↓
Match                against the collection's existing compiled pages
  ↓
Update               within the collection's TRUST BOUNDARY
  ↓
Flag                 contradictions and stale entries → human review
  ↓
Brief                a change report of everything the pass did
```

Two properties matter more than the rest:

1. **It fails closed.** A model reply that doesn't parse compiles *nothing*. An
   update the policy won't allow becomes a review item, never a silent write.
2. **It never resolves a contradiction.** When new evidence disagrees with a
   compiled page, the page is left alone and a conflict is raised. Choosing which
   source is current is the human's job.

## Collections become compilation domains

A collection already grouped content. Now it also defines *what gets compiled
together*, and how freely. Its **policy** (`compile_policies`) is the trust
boundary:

| Setting | What it does |
| --- | --- |
| `enabled` | Whether this collection compiles at all |
| `autonomy` | `suggest` \| `guarded` (default) \| `auto` — see below |
| `compile_sources` | Which raw kinds feed it (file, link, message, artifact, todo, meeting, note) |
| `maintain_kinds` | Which page kinds it maintains |
| `never_auto` | Guards matched against a page's kind, labels or title |
| `min_confidence` | Updates below this go to review |
| `stale_days` | A page unreviewed this long is flagged stale |

### Autonomy

Compilation is **not** unrestricted autonomous editing. Updates are ranked by how
destructive they are — `create` < `append` < `revise` < `supersede` — and
autonomy sets the ceiling on what may be written unattended:

| Level | Applies | Goes to review |
| --- | --- | --- |
| `suggest` | nothing | everything |
| `guarded` *(default)* | create, append | revise, supersede |
| `auto` | create, append, revise | supersede |

`supersede` — replacing a page wholesale — **always** needs a human, at every
level. `guarded` is the default because the safe posture is "grow knowledge
freely, rewrite it deliberately".

### Guards that hold at every level

Regardless of autonomy, an update goes to review when:

- the target page matches a `never_auto` guard (`financial commitments`,
  `client-facing`, `published`, …),
- the update contradicts existing compiled knowledge,
- the page is **human-confirmed** and the update is anything but an append,
- the update's confidence is below the threshold,
- the operation is a `supersede`.

A human-confirmed page can still be *appended to*. It just can't be rewritten
behind your back.

The whole decision is one pure function — `classifyUpdate` in
`supabase/functions/_shared/compiler.ts` — and it is the most heavily tested
thing in this feature, because it is what stands between "new evidence arrived"
and "the machine rewrote a page nobody re-read".

## Conflicts

The biggest benefit and the biggest risk. Detection is first-class; resolution is
not automated. A conflict is written as a durable review item:

```
CONFLICT DETECTED

New source:
Payment schedule changed to biweekly.

Existing knowledge:
Money Plan assumes monthly payments.

Impact:
Budget projections may be incorrect.

Suggested action:
Confirm which schedule is current.
```

The page is marked `contradicted` — so it stops being presented as current — and
waits. Two categories land in the queue:

- **conflict** — genuine contradiction between sources.
- **held** — an update the trust boundary declined, parked *with the body it
  wanted to write*, so approving it later is a click rather than a re-run. The
  page it targets is flagged `needs-review` and the compiled-context block says
  so inline — otherwise the page keeps reading as settled truth while the
  revision waits in the queue, and the review gate quietly becomes a staleness
  bug. A page already marked `contradicted` keeps that worse flag; a
  human-confirmed page keeps its sign-off, since a machine's suggestion does not
  retroactively un-confirm what a person accepted.

Resolving is a human decision recorded three ways: **use the new source**
(applies it and marks the page confirmed), **keep what we have** (clears the
dispute, stamps the review), or **dismiss**.

Because a person just read it, resolving marks the page `human_confirmed` — and
its freshness clock restarts from a human's look, not from the compiler's last
touch.

## Provenance

Every compiled claim keeps: the source it came from, when it was captured, its
confidence, whether a human confirmed it, and which run wrote it
(`knowledge_claims`). Claims are deduplicated by a normalized fingerprint, so
re-running a pass over overlapping sources doesn't restate the same claim
forever. `knowledge_links` records the explicit relationships — which sources
support which concepts, which pages depend on which.

## Compiled-first context

The center-of-gravity shift, in one place. `loadCollectionsContext` now leads
with a collection's compiled pages and follows with its raw material, labelled as
the evidence behind them. Any page that is not plainly current — contradicted,
awaiting review, or stale — is flagged inline so the assistant qualifies it
rather than asserting it. Collections with nothing compiled yet are unchanged —
the raw block is simply all there is.

That inline flagging is load-bearing, not decoration. Compilation's failure mode
is *confidence*: a compiled page reads as settled truth in a way a pile of raw
documents never does, so anything less than settled has to say so in the same
breath it is quoted.

`search_documents` still works and still matters. It becomes the fallback for
"nothing compiled yet", "I need the source's exact wording", and "this page is
disputed" — rather than the primary intelligence layer.

## Using it

### In the app

**Knowledge** (sidebar, under Assets) has four tabs, ordered by where attention
should go:

- **Review** — conflicts and held updates. Leads on purpose.
- **Compiled** — the maintained pages, grouped by kind.
- **Briefs** — what each pass changed, with a live checklist while one runs.
- **Policy** — the per-collection trust boundary, and *Compile now*.

A pass runs in the background and is followed over Realtime.

### From chat, agents, or an external Claude

Eight builtin tools, available to every agent loop and over MCP:

| Tool | What it does |
| --- | --- |
| `compile_collection` | Run a pass; returns the change brief |
| `list_knowledge_pages` | The compiled layer — check here *before* searching raw docs |
| `get_knowledge_page` | One page in full, with the claims behind it |
| `update_knowledge_page` | Author or maintain a page directly |
| `list_conflicts` | What is awaiting a human decision |
| `resolve_conflict` | Record a decision the user actually made |
| `get_change_brief` | What a pass changed |
| `set_compile_policy` | Edit the trust boundary |

`update_knowledge_page` is deliberately narrower than the compiler itself: append
and revise only, never a wholesale supersede, and a human-confirmed page is only
appended to — the same invariant `classifyUpdate` enforces, so there is no way to
route around the trust boundary by calling the tool instead.

### Over HTTP

```bash
curl -X POST "$SUPABASE_URL/functions/v1/compile" \
  -H "Authorization: Bearer $MCP_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"collection": "Money Plan", "dry_run": true}'
```

Auth is a session JWT or a personal `mcp_tokens` bearer, like `run-tool`. Add
`"background": true` to fire and follow `compile_runs` instead of waiting.

### On a schedule

Compilation is an ordinary builtin, so a nightly pass is an agent scoped to
`compile_collection` on a `schedules` row — no new plumbing. Every pass emits
`knowledge.compiled`, and each conflict emits `knowledge.conflict_detected`, so a
listener can route a brief to Slack or email, or react to a contradiction.

## Where the risk is

Compilation amplifies mistakes. A bad source in a search result is isolated; a
bad source folded into compiled knowledge spreads into every answer built on it.
That is why the design is what it is:

- automatic compilation only for low-risk, additive knowledge,
- human approval for contradictions and for rewrites,
- `never_auto` guards for financial commitments, client-facing and published
  content,
- explicit provenance on every claim,
- a compiled page's own artifact mirror is excluded from the source sweep, so the
  compiler can never compile its own output.

## Files

| Path | What |
| --- | --- |
| `supabase/functions/_shared/compiler.ts` | The pure core — policy, prompt, parsing, matching, **the trust boundary**, staleness, briefs |
| `supabase/functions/tests/compiler_test.ts` | 61 unit tests, weighted toward the trust boundary |
| `supabase/functions/compile/index.ts` | The pass: gather → extract → apply → flag → brief |
| `supabase/functions/_shared/compiler_tools.ts` | The eight builtins, shared with MCP |
| `supabase/functions/_shared/collections.ts` | Compiled-first context injection |
| `src/lib/compiler.ts` | Browser mirror (labels, policy round-trip, grouping) |
| `src/pages/KnowledgePage.tsx` | The Knowledge dashboard |
| `supabase/migrations/0112_knowledge_compiler.sql` | Schema, RLS, events, seeded tools + always-on prompt |

## Not built yet

- Retrieval *over* compiled pages (they are injected whole, budgeted, today).
- A visual relationship graph — `knowledge_links` is written but not yet drawn.
- Publishing a compiled page to a durable artifact URL from the UI (the mirror is
  maintained when `artifact_id` is set; nothing sets it yet).
- A maintained workspace/personal profile page compiled from memory + activity.
- Compiling straight from an `event` as sources land, rather than per pass.
