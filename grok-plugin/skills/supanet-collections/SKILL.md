---
name: supanet-collections
description: >-
  Group SupaNet content into collections and work with the compiled knowledge
  layer - pull a whole collection in one call, file items into it, compile raw
  material into maintained knowledge pages, review contradictions, and set the
  per-collection trust boundary. Use when the user wants to organize or tag
  workspace content, scope a conversation to one topic, ingest notes/transcripts/
  articles from elsewhere, ask what the team knows about something, or resolve
  conflicting information in their knowledge base.
---

# Collections and compiled knowledge

## Collections - the unit of focus

A collection is a named group of workspace content: artifacts, files, to-dos,
links, tables, inbox messages, whiteboards and card boards. Its purpose is to let
someone scope a conversation to one topic - "chat with the Acme account" - and to
give agents a bounded context to work from.

### Reading

- `list_collections` - what exists. **Run this before creating one**; workspaces
  accrete near-duplicate collections fast.
- `get_collection` - the whole bundle in one call: metadata, artifacts with full
  content, files with signed URLs, links, to-dos with notes, tables with schema
  and row counts, and inbox messages.
  - `since` (ISO 8601) gives you a cheap diff - "what landed in this collection
    since yesterday" without re-reading everything.
  - `include` narrows to a subset when you only need one content type.

### Writing

- `create_collection` - name plus description.
- Most authoring tools take a `collection` (or `collections`) argument directly:
  `create_artifact`, `create_todo`, `create_file`, `save_link`, `save_message`,
  `add_note`. Filing at creation is one call instead of two - prefer it.
- File existing items with `add_to_collection` (artifacts, by id **or** exact
  title), `add_file_to_collection`, `add_todo_to_collection`,
  `add_link_to_collection`, `add_table_to_collection`,
  `add_message_to_collection`, `add_whiteboard_to_collection`,
  `add_card_board_to_collection`. Filing is additive and the collection is
  created if missing.

### Visibility

A collection is `private` (owner and admins) or `workspace` (every member can
read and collaborate). The join tables inherit the collection's visibility, so
filing an item into a workspace collection shares it with the team. Say so when
you do it.

### Collections as an ingestion target

This is the high-value pattern from a coding agent: push content from other
systems in - blog posts, transcripts, research notes, changelogs, scraped
articles - into a named collection the team can then chat with. `add_note` plus
`create_artifact` with a `collections` array covers most of it.

## The compiled knowledge layer

The distinction the whole feature rests on: **a raw file is not an answer, it is
evidence.** Searching raw documents makes the model re-interpret them on every
question. Compiling turns "add information → search for it later" into "add
information → interpret it → link it → update existing knowledge → flag
conflicts → produce a brief".

A **knowledge page** is a maintained page (concept, decision, process, person,
project, terminology, principle, question, profile) with a stable `key`, so a
refined page overwrites **in place** rather than minting a near-duplicate. Every
compiled claim keeps a pointer back to the source it came from.

### Tools

| Tool | Use |
| --- | --- |
| `compile_collection` | run a compilation pass over a collection |
| `list_knowledge_pages` / `get_knowledge_page` | read the compiled layer |
| `update_knowledge_page` | append or revise a page |
| `list_conflicts` / `resolve_conflict` | work the review queue |
| `get_change_brief` | what a pass actually changed |
| `set_compile_policy` | the per-collection trust boundary |

### Read compiled first

When answering a question about the team's knowledge, **check the compiled pages
before falling back to `search_documents`.** Raw search is the fallback for three
cases: nothing has been compiled yet, you need exact wording, or the compiled
page is marked disputed.

A page carries a lifecycle `status` - `compiled`, `needs-review`,
`contradicted`, `stale`, `confirmed`, `archived`. If a page is `contradicted` or
`stale`, **say so in your answer** rather than asserting it as settled fact.

### The rules compilation will not break

These are enforced, and you should not try to route around them:

- **Never pick a winner in a contradiction.** The compiler detects one, leaves
  the page alone, marks it `contradicted`, and files a review item. A human
  resolves it. You do the same: surface the conflict, present both sides with
  their sources, and let the user decide.
- **A human-confirmed page is append-only.** Someone read and confirmed it;
  a tool call does not get to rewrite it.
- **Wholesale replacement is never unattended** at any autonomy level.
- `update_knowledge_page` is deliberately narrower than the compiler itself
  (append or revise only) so a tool call cannot bypass the trust boundary.

### The trust boundary

`set_compile_policy` configures, per collection: the `autonomy` level
(`suggest` = nothing applies unattended; `guarded`, the default = creates and
additive appends apply while rewrites go to review; `auto` = rewrites apply too),
which source kinds feed it, which page kinds it maintains, `never_auto` guards
matched against a page's kind/labels/title (for example "financial commitments",
"client-facing"), a confidence floor, and a staleness horizon.

Changing this widens what an automated pass may do without a human looking.
**Confirm with the user before loosening it**, and never raise autonomy on your
own initiative.

## Working style

Prefer `get_collection` over a series of `list_*` calls when you need context -
one call, everything, with `since` for diffs. When you file something, name the
collection you put it in and whether that shared it with the team.
