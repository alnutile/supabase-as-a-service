---
name: supanet-artifacts
description: >-
  Create, update, share and publish SupaNet artifacts - markdown docs, code,
  text, and HTML pages including standalone sites and interactive stateful
  trackers. Use when the user wants to save or share a document, publish an HTML
  page or diagram, hand someone a link (optionally password-protected), turn a
  draft into a living doc, build a checklist or tracker that remembers clicks, or
  recover something they deleted from their SupaNet workspace.
---

# SupaNet artifacts

An artifact is a saved document in the user's workspace: `markdown`, `code`,
`text`, or `html`. It has an owner, a visibility, and - once shared - a stable
public URL.

## The core loop

```
list_artifacts  → find what already exists (newest first, with ids)
get_artifact    → read the current version (by id or exact title)
update_artifact → evolve it IN PLACE
create_artifact → only when nothing suitable exists
```

**The failure this prevents:** minting "Q3 Plan (v2)", "Q3 Plan final",
"Q3 Plan final 2". If the user says "update the X doc", find X and update it. Only
create when there is genuinely nothing to update.

`create_artifact` returns the new **id** and share link, and accepts a
`collections` array, so filing into one or more collections happens in the same
call - no follow-up lookup needed.

## Visibility and sharing

| Visibility | Who can read |
| --- | --- |
| `private` (default) | owner and admins |
| `unlisted` | anyone with the link |
| `public` | anyone with the link; discoverable |

Anything non-private gets a `public_slug` and a share URL. Default to the
least-open option that meets the request and say which you picked - "I made it
unlisted, so only people with the link can read it" beats silently publishing.

**Optional share password.** An unlisted or public artifact can require a
password (set in the app's Sharing panel, bcrypt-hashed). This is not client-side
theater: with a password set, the read policy hides the whole row from
non-owners, so the content never reaches an anonymous client at all. Useful for
handing a customer a link plus a password. Note that password-protected artifacts
deliberately 404 on the raw `p` edge-function URL.

## HTML artifacts

An `html` artifact is a real page, not a code sample.

- It renders at the app's own **`/p/:slug`** route as a clean, chrome-free,
  full-viewport page - good for sharing a diagram, a report or a one-pager
  publicly without deploying an app.
- It runs inside a sandboxed iframe on an **opaque origin**: JavaScript works,
  but there is no access to cookies, `localStorage`, the session or the parent
  page. Write pages that do not need any of those.
- Because the page is served straight from the artifact's content, editing the
  artifact updates the live URL immediately.
- Load libraries from a CDN over HTTPS if you need them, but keep everything in
  the one document - there is no bundler and no second file.

### Interactive artifacts (stateful trackers)

An HTML artifact can persist user state - a tracker, kanban, or checklist where
clicks survive a reload. The page never sees credentials; it talks a small
`postMessage` protocol to its host, which does the saving:

1. The page posts `artifact:ready` when it loads.
2. The host replies `artifact:state` with the saved JSON.
3. On every user change the page posts `artifact:save` with the new state, and
   the host persists it (debounced) under the caller's own permissions.

On the public standalone page the saved state is injected as
`window.__ARTIFACT_DATA__` for a read-only render. Save calls from a non-owner
are silently no-ops, so a shared tracker is safe to hand out.

To evolve one: `get_artifact` to read the current HTML and state, then
`update_artifact`. Do not rebuild it from scratch - you would lose the saved data
the user has accumulated.

## Delete and recover

`delete_artifact` **archives** by default: the row disappears from every normal
view but stays recoverable in the workspace's Trash panel, and the owner still
sees it. That is what you want almost always.

- `restore_artifact` brings an archived one back.
- `list_artifacts` with the `archived` filter is the recovery area.
- `delete_artifact` with `permanent: true` destroys the row. Only do this when
  the user explicitly asks for permanent deletion - confirm first.

## The `:::artifact` protocol - in-app chat only

Inside the app's own chat the assistant can emit an artifact inline:

```
:::artifact {"title":"Short descriptive title","type":"markdown"}
...the full content...
:::
```

**Over MCP - which is what you are doing from Grok - use `create_artifact`
instead.** Emitting the block here just prints literal text; nothing is saved.
Mention the protocol only if the user is writing prompts or skills that run
inside the app's chat.

## Practical notes

- Titles are matched exactly by `get_artifact` and `add_to_collection`, so keep
  them short and stable, and prefer ids once you have one.
- Images inside markdown artifacts must be publicly reachable URLs, since the
  markdown is re-rendered for anonymous visitors forever. Publish an image via
  the Files area to get a stable public URL rather than using an expiring signed
  one.
- After any write, hand back the share link - that is the deliverable.
