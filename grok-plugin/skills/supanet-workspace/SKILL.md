---
name: supanet-workspace
description: >-
  The full capability map for operating a SupaNet workspace over the supanet MCP
  server - artifacts, collections, to-dos, links, files, knowledge base, tables,
  user memory, and the automation layer - plus the access model and working
  rules. Use whenever the user talks about their SupaNet workspace, their
  intranet or "the team space", or asks to save or share a doc, add a to-do or
  bookmark, push notes or transcripts into the knowledge base, query a table,
  file something into a collection, or set up an agent or webhook - even if they
  never name the tool.
---

# Working in a SupaNet workspace

A SupaNet workspace is a team intranet on Supabase. You reach it through the
`supanet` MCP server. If those tools are not available, load
`supanet-getting-started` first.

**The golden rule: do the thing, don't just describe it.** Call the tool so the
work lands in the workspace, then hand back the concrete result - the share link,
the file URL, the row id.

## Capability map

Each area below is a real feature with real tools. Reach for the tool; don't
reinvent it.

### Artifacts - shareable documents (markdown / code / html / text)
An artifact is a saved, optionally-shareable document. HTML artifacts can render
as a clean full-page site and can be interactive (stateful trackers, checklists).

- `create_artifact` - returns its **id + share link**. Pass `collection` /
  `collections` to file it while creating.
- `get_artifact` - read one by id or exact title. **Always call this before
  editing.**
- `update_artifact` - evolve one **in place** rather than minting a near-duplicate.
- `list_artifacts` - newest-first with ids; filter by collection / title / type.
- `delete_artifact` archives by default (recoverable); `permanent: true` destroys.
  `restore_artifact` brings an archived one back.

Deep dive: `supanet-artifacts`.

### Collections - a named set you can focus a chat on
A collection groups artifacts, files, to-dos, links, whiteboards, card boards and
tables so the team can scope a conversation to one topic.

- `create_collection`, `list_collections`, `get_collection` (pulls the whole
  bundle - meta plus items - with an optional `since` for a cheap daily diff).
- File items in with `add_to_collection` (artifacts, by id *or* exact title),
  `add_file_to_collection`, `add_todo_to_collection`, `add_link_to_collection`,
  `add_table_to_collection`, `add_message_to_collection`,
  `add_whiteboard_to_collection`, `add_card_board_to_collection`. The collection
  is created if it does not exist.

Deep dive: `supanet-collections`.

### To-dos - the shared task list
- `create_todo` (title + optional notes / due_date / collection / visibility),
  `list_todos`, `complete_todo`, `update_todo`.
- `visibility` is `private` (default - owner and admins) or `workspace` (the whole
  team; `team` and `shared` are accepted aliases). The default is deliberately
  private: filing work *at* one person should not quietly publish it. Pass
  `workspace` when the user says "share this with the team".
- To-dos also carry lifecycle lanes - `triage` → `next` → `doing` → `blocked` →
  `done`. Agent- and API-filed to-dos land in `triage`; work a person has
  committed to belongs in `next`.

### Links - shared bookmarks with metadata fetched server-side
- `save_link` (paste a URL; title, description, preview image and favicon are
  fetched for you), `list_links` (supports `since` / `until` date ranges),
  `add_link_to_collection`.

### Files - persist real bytes, get a shareable URL
Most valuable for **binary output you generate** (e.g. a base64 PNG from an image
model): store it so the user gets a stable link instead of raw base64.

- `create_file` - pass `content_base64` **or** `content_text`, plus `filename`
  and optional `mime_type` / `visibility` / `collection` / `tags`. Returns a file
  id and a 7-day signed URL. PDFs are auto-indexed into the knowledge base.
- Files over ~10 MB: `create_file_upload` → PUT the bytes to the returned URL →
  `finalize_file_upload` with the same path.
- `list_files`, `get_file` (fresh signed URL; `include_text` for small text
  files), `delete_file`.

### Knowledge base - searchable team memory
- `add_note` - push meeting notes, transcripts or any text in; it is chunked,
  embedded and made searchable for the whole team.
- `search_documents` - semantic search over indexed PDFs and notes. **Cite the
  document name** in your answer.
- `summarize_resource` - condense a stored resource.

### Tables - real Postgres tables (Airtable, but SQL)
- `create_table` (typed columns), `list_tables`, `query_table` (returns row ids;
  supports filters and `since`), `add_table_row`, `update_table_row` (**requires**
  a `match` filter so a call cannot rewrite a whole table), `delete_table_row`.

Deep dive: `supanet-tables`.

### Planner - whiteboards and card boards
- Whiteboards are Excalidraw canvases the AI can read *and* draw on:
  `create_whiteboard`, `list_whiteboards`, `get_whiteboard`, `update_whiteboard`
  (replace or append elements).
- Card boards are free-form card walls where position is the priority ranking and
  card size is the weight: `create_card_board`, `list_card_boards`,
  `get_card_board`, `add_cards` (each card takes `text`, optional `color` and a
  named `size` of small / medium / large / huge).

Good for "draw me a flowchart" and "brain-dump these ten ideas as cards".

### User memory - durable facts about *this* user (private)
Carries across conversations so a fresh chat starts warm.

- `remember` - durable facts, defaults, preferences, stack, ongoing projects.
  Pass a stable `key` to upsert in place instead of accumulating near-duplicates.
  **Never** store secrets or one-off details.
- `list_memories`, `update_memory`, `forget`.

Memory is owner-only - one user's memories never reach another's context.

### Automation
`create_agent`, `create_http_tool`, `create_webhook`, `create_skill` and the loop
tools. Deep dive: `supanet-automation`.

### Inspection before creation
`list_collections`, `list_tools`, `list_agents`, `list_artifacts`,
`list_activity` / `get_activity`. A quick `list_*` before creating a collection,
agent or tool avoids duplicates - do it.

### Passthrough integrations
If the workspace has connected external MCP servers (Zapier, Playwright, and so
on), their tools are re-exposed here under a `<label>__<remote>` name. Use them
the same way.

## Access model - stay inside the user's lane

Most content is either **private** (owner and admins) or **workspace** (every
member can read and collaborate). You act as the token's owner, and the workspace
re-enforces access in code on top of row-level security.

- Default to the **least-open visibility** that meets the request, and say which
  one you chose.
- A denied call means the user genuinely lacks access. Report it; never look for
  a way around it.
- Never put a credential into an artifact, a to-do, a table row or a memory.
  Workspace secrets belong in the Vault and are referenced as
  `{{vault:secret_name}}` from a tool config.

## Charts and visualizations

There is no JSON or React chart component here. Visuals render as a **single
self-contained `html` artifact** in a sandboxed iframe (JavaScript runs; there is
no access to cookies, storage, the session or the parent page). Draw inline SVG
for simple charts; for richer ones load a library from a CDN over HTTPS and
render into a `<canvas>` or `<div>`. Keep everything inside the one HTML
document - do not emit a chart spec expecting something else to render it.

## Working style

Be concise and practical. Prefer acting over explaining how the user could act.
After a write, hand back the concrete result. Ask a clarifying question only when
two readings would produce genuinely different work.
