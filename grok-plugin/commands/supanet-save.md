---
description: Save the current work - a doc, notes, a file, or a link - into the SupaNet workspace and hand back the share link.
argument-hint: "[what to save, and optionally a collection name]"
---

Capture something from this session into the user's SupaNet workspace so it
outlives the terminal. The user asked to save: **$ARGUMENTS**

If the `supanet` tools are not available, run `/supanet-connect` first rather
than describing what you would have saved.

Decide what it actually is, then use the matching tool:

| It is… | Use | Notes |
| --- | --- | --- |
| a document, write-up, summary, or plan | `create_artifact` (`markdown`) | returns id + share link |
| source code or a config worth keeping | `create_artifact` (`code`) | |
| a page, report or diagram to show people | `create_artifact` (`html`) | renders as a standalone page |
| meeting notes, a transcript, reference text | `add_note` | chunked + embedded, team-searchable |
| a real file or generated binary | `create_file` | `content_text` or `content_base64`; returns a signed URL |
| a URL worth keeping | `save_link` | title/description/preview fetched for you |

Then:

1. **Check for an existing version first.** If this updates something that
   already exists, `list_artifacts` / `get_artifact` and `update_artifact` in
   place. Do not mint "… v2".
2. **File it into a collection** if the user named one, or if one obviously fits
   - pass `collection` / `collections` in the same call rather than following up.
   Run `list_collections` first so you match an existing name instead of creating
   a near-duplicate.
3. **Pick the least-open visibility** that meets the request, and say which one
   you chose. Default to private unless they asked to share it.
4. **Never include credentials** - API keys, tokens, `.env` contents - in what
   you save. If the content has any, strip them and tell the user what you
   removed.

Finish with the concrete result: the share link, file URL, or id. That link is
the deliverable, not your description of it.
