---
description: Catch up on a SupaNet workspace - what changed recently, what is open, and what needs a human.
argument-hint: "[collection name, or a time window like 'since yesterday']"
---

Give the user a short, scannable picture of their SupaNet workspace. Scope:
**$ARGUMENTS** (if empty, cover the whole workspace over the last 7 days).

If the `supanet` tools are not available, run `/supanet-connect` first.

Gather, in parallel where you can:

1. **If a collection was named** - `get_collection` with `since` set to the start
   of the window. One call returns the whole bundle plus the diff; do not stitch
   it together from several `list_*` calls.
2. **Otherwise** - `list_artifacts` and `list_links` with `since`, `list_todos`
   filtered to open, and `list_activity` for the window.
3. **What needs a person** - `list_conflicts` for contradictions in the compiled
   knowledge layer, and any knowledge page marked `contradicted` or `stale`.

Report it as:

- **Landed** - what was created or updated, newest first, with links.
- **Open** - unfinished to-dos, overdue ones first. Note which are team-visible.
- **Needs you** - knowledge conflicts, disputed pages, anything blocked. Lead
  with this if it is non-empty; it is the part that does not resolve itself.

Rules:

- Keep it tight. A dozen lines someone reads beats an exhaustive dump they skip.
- **Do not resolve a knowledge conflict yourself.** Surface both sides with their
  sources and let the user decide - that boundary is deliberate.
- Flag disputed or stale pages as disputed rather than restating them as fact.
- Link to things. A title with no link is a dead end.
- If nothing changed in the window, say exactly that instead of padding.
