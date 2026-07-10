---
name: intranet-workspace
description: >-
  How to operate the user's Supabase-powered team intranet through its connected
  "intranet" MCP server — creating and sharing artifacts (docs/code/HTML pages),
  filing content into collections, managing to-dos, links, files, data tables,
  user memory, and the shared knowledge base, and building agents/tools/webhooks.
  Use this WHENEVER the user talks about their intranet, their workspace, "the
  team space", or asks to save/share a doc or artifact, add a to-do or bookmark,
  push notes/transcripts into the knowledge base, create or query a table, file
  something into a collection, or set up an agent/webhook/loop — even if they
  don't name the tool. If intranet MCP tools (mcp__intranet__*) are available,
  prefer them over answering in plain prose.
---

# Working in the Supabase intranet

This skill helps you operate a Supabase-powered team intranet: a shared workspace
with chat, shareable **artifacts**, **collections**, **to-dos**, **links**,
**files**, real Postgres **tables**, a PDF **knowledge base**, per-user
**memory**, and an automation layer (agents, tools, webhooks, loops). You reach
it through the connected **`intranet` MCP server** (tools named
`mcp__intranet__*`).

The golden rule: **do the thing, don't just describe it.** If the user asks to
save a doc, capture a link, add a task, or file something into a collection, call
the matching tool so it actually lands in their workspace — then hand back the
link/id. Prose alone leaves nothing in the intranet.

## First: is the intranet connected?

If no `mcp__intranet__*` tools are available, the workspace's MCP server isn't
connected in this client. Tell the user to grab their connection snippet from the
app under **Settings → Connect Claude** (it issues a per-user token and gives the
`claude mcp add` command for Claude Code and the `claude_desktop_config.json`
block for Claude Desktop). Everything below assumes the tools are present.

## The capability map

Each area below is a real feature with real tools. Reach for the tool; don't
reinvent it.

### Artifacts — shareable documents (markdown / code / html / text)
An artifact is a saved, optionally-shareable document. HTML artifacts can be a
clean full-page site and can be interactive (stateful trackers/checklists).
- `create_artifact` — make one; returns its **id + share link**. Pass
  `collection` / `collections` to file it while creating.
- `get_artifact` — read one by id or exact title (use before editing).
- `update_artifact` — evolve one **in place** rather than minting a duplicate.
- `list_artifacts` — newest-first with ids; filter by collection / title / type.

When chatting *inside the app* (not over MCP), you can also emit an artifact
inline with the `:::artifact` protocol — see "Artifact protocol" below.

### Collections — a named set you can chat with
A collection tags together artifacts, files, to-dos, links, and tables so the
team can focus a chat on one topic. Great for centralizing content from other
systems (blog posts, transcripts, notes).
- `create_collection`, `list_collections`, `get_collection` (pull the whole
  bundle — meta + items — with optional `since` for a daily diff).
- File existing items in: `add_to_collection` (artifacts, by id *or* exact
  title), `add_file_to_collection`, `add_todo_to_collection`,
  `add_link_to_collection`, `add_table_to_collection`, `add_message_to_collection`.
  The collection is created if it doesn't exist.

### To-dos — the shared task list
- `create_todo` (title + optional notes / due_date / collection), `list_todos`
  (filter open|done), `complete_todo`, `update_todo`.

### Links — shared bookmarks (metadata auto-fetched)
- `save_link` (paste a URL; title/description/preview are fetched server-side),
  `list_links`, `add_link_to_collection`.

### Files — persist real bytes, get a shareable URL
Most important for **binary output you generate** (e.g. a base64 PNG from an
image model): store it so the user gets a stable link instead of raw base64.
- `create_file` — pass `content_base64` **or** `content_text` (+ filename,
  mime_type, optional visibility / collection / tags); returns a **file id +
  signed URL**. PDFs are auto-indexed into the knowledge base.
- Large files (>~10 MB): `create_file_upload` → PUT the bytes →
  `finalize_file_upload`.
- `list_files`, `get_file` (fresh signed URL; `include_text` for small text),
  `delete_file`.

### Knowledge base (RAG) — searchable team memory of documents & notes
- `add_note` — push meeting notes / transcripts / any text in; it's chunked,
  embedded, and made searchable by the whole team.
- `search_documents` — semantic search over indexed PDFs + notes; **cite the
  document name** in your answer.

### Tables — real Postgres data tables (Airtable-but-SQL)
- `create_table` (typed columns), `list_tables`, `query_table` (returns row ids;
  supports filters + `since`), `add_table_row`, `update_table_row` (requires a
  `match` filter so you can't rewrite the whole table), `delete_table_row`.

### User memory — durable facts about *this* user (private)
Carries across chats so a fresh conversation starts warm.
- `remember` (durable facts/preferences; pass a stable `key` to upsert in place —
  never store secrets or one-offs), `list_memories`, `update_memory`, `forget`.

### Automation & building blocks
- `create_agent` — a named unit (instructions + scoped tool_ids) that appears in
  the dashboard and can run on a schedule or from a webhook.
- `create_http_tool` — a custom tool the assistant can call (admin); reference
  workspace Vault secrets with `{{vault:secret_name}}` so credentials never
  appear in the tool row or the chat.
- `create_webhook` — a public URL that runs a prompt over inbound payloads.
- `create_skill` / `list_skills` / `get_skill` / `update_skill` / `delete_skill`
  — manage saved prompts. `always_on` prompts apply to every chat (**admin
  only**); on-demand skills are personal and invoked with "/".
- `create_loop` / `run_loop` / `get_loop_run` / `list_loops` — goal-directed runs
  that iterate toward a rubric within a budget.
- `list_tools`, `list_agents`, `list_activity` / `get_activity` — inspect what
  the workspace already has before creating duplicates.
- Messages inbox: `save_message`, `list_messages`.

### Passthrough integrations
If the workspace has connected external MCP servers (e.g. Zapier → Gmail /
Calendar), their tools appear namespaced (e.g. `mcp__intranet__zapier__*`). Use
them the same way.

## Access model — stay inside the user's lane

Most content is either **private** (owner + admins) or **workspace** (every
member can see and collaborate). You act as the token's owner and the workspace
re-enforces access in code, so only surface or modify what this user is allowed
to. When creating shareable things, default to the least-open visibility that
meets the request and say what you chose.

## Artifact protocol (in-app chat only)

When you're the assistant *inside the app's own chat* (not calling MCP from an
outside client), you can create an artifact by emitting ONE block in exactly this
format — the app saves it and swaps in a share link:

```
:::artifact {"title":"Short descriptive title","type":"markdown"}
...the full content of the artifact...
:::
```

Rules: `type` is one of markdown | code | html | text; put **only** the content
between the fences; don't wrap the block in code fences or explain the format.
Over MCP, use `create_artifact` instead — same result, returns the id + link.

## Charts & visualizations

There is no JSON/React chart component here — visuals render as a **single
self-contained `html` artifact** in a sandboxed iframe (JS enabled; no access to
cookies, storage, session, or the parent page). For simple charts draw inline
SVG; for richer ones load a library from a CDN over HTTPS and render into a
`<canvas>`/`<div>`. Keep everything inside the one HTML document. Don't emit
chart-spec JSON expecting it to render on its own.

## Working style

Be warm, concise, and practical. Prefer acting (create the to-do, save the link,
update the artifact, query the table, file into the collection) over describing
how the user could. Before creating something that might already exist (a
collection, an agent, a tool), a quick `list_*` avoids duplicates. After a write,
hand back the concrete result — the share link, the file URL, the row id. Ask a
clarifying question only when genuinely needed.
