# Artifacts CRUD API

A small, plain‑REST API for pushing **artifacts** (docs / code / HTML / text)
into the workspace from anywhere — a script, a Zap, a cron job, another app —
without speaking MCP or holding a Supabase session. It also lets you **tag**
each artifact into one or more **collections** (the named groups you chat with
in the app).

It is the Supabase edge function `artifacts` (`supabase/functions/artifacts`),
deployed public (`verify_jwt = false`) and gated instead by a per‑user **bearer
token**.

## Auth

Send a personal connection token as a bearer token:

```
Authorization: Bearer <token>
```

These are the same **MCP tokens** you mint in the app under **Settings →
Connect Claude** (table `mcp_tokens`). Every call runs **as that token's
owner** — you only ever see and modify your own artifacts. Revoke a token in
the same place to cut off access.

> The function runs with the service role and re‑enforces ownership in code, so
> the token → owner mapping *is* the security boundary. Treat the token like a
> password; rotate it if leaked.

## Base URL

```
https://<your-project>.supabase.co/functions/v1/artifacts
```

Opening that URL in a browser (no `Authorization` header), or `GET …/artifacts/docs`,
returns a plain‑text version of these docs.

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/artifacts` | List your artifacts (metadata only by default). |
| `POST` | `/artifacts` | Create an artifact. |
| `GET` | `/artifacts/:id` | Read one (includes `content` and its `collections`). |
| `PATCH` / `PUT` | `/artifacts/:id` | Update the fields you send; add collection tags. |
| `DELETE` | `/artifacts/:id` | Delete one. |

### `GET /artifacts` — list

Query parameters (all optional):

| Param | Meaning |
| --- | --- |
| `collection` | Only artifacts in this collection (name or id). |
| `type` | `markdown` \| `code` \| `html` \| `text`. |
| `q` | Title contains this text (case‑insensitive). |
| `include=content` | Include the full `content` in each row (omitted by default). |
| `limit` | 1–200, default 50. |
| `offset` | Paging offset, default 0. |

Response:

```json
{
  "artifacts": [
    {
      "id": "…",
      "title": "Hello",
      "type": "markdown",
      "language": null,
      "visibility": "private",
      "public_slug": null,
      "share_url": null,
      "created_at": "…",
      "updated_at": "…"
    }
  ],
  "count": 1
}
```

### `POST /artifacts` — create

JSON body:

| Field | Required | Notes |
| --- | --- | --- |
| `title` | yes | |
| `content` | yes | The artifact body. |
| `type` | no | `markdown` (default) \| `code` \| `html` \| `text`. |
| `language` | no | Hint for `code` artifacts (e.g. `ts`). |
| `visibility` | no | `private` (default) \| `unlisted` \| `public`. Non‑private mints a `public_slug`. |
| `collection` | no | A collection **name or id** to file into — created if it doesn't exist. |
| `collections` | no | An array of names/ids, same rules. |

Returns `201` with the created artifact (including `content` and the
`collections` it was filed into).

### `GET /artifacts/:id` — read

Returns the full artifact including `content` and the list of `collections` it
belongs to. `404` if it isn't yours / doesn't exist.

### `PATCH /artifacts/:id` — update

Send only the fields you want to change (`title`, `content`, `type`,
`language`, `visibility`). `PUT` behaves the same. Passing `collection` /
`collections` **adds** the artifact to those collections — existing tags are
kept, not replaced. Flipping `visibility` to non‑private mints a share link if
one didn't exist.

### `DELETE /artifacts/:id`

Returns `{ "deleted": true, "id": "…" }`, or `404` if not found.

## Errors

Errors are JSON: `{ "error": "message" }` with an appropriate status
(`400` bad input, `401` missing/invalid token, `404` not found, `405` wrong
method/path, `500` server error).

## Examples

```bash
TOKEN=…   # from Settings → Connect Claude
BASE=https://<your-project>.supabase.co/functions/v1/artifacts

# Create a markdown artifact and tag it into "Blog" (collection auto-created)
curl -X POST "$BASE" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"title":"Hello","content":"# Hi","type":"markdown","collection":"Blog"}'

# List artifacts in a collection
curl "$BASE?collection=Blog" -H "Authorization: Bearer $TOKEN"

# Read one with its content
curl "$BASE/<id>" -H "Authorization: Bearer $TOKEN"

# Update content and publish it (get back a share_url)
curl -X PATCH "$BASE/<id>" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"content":"# Updated","visibility":"public"}'

# Delete
curl -X DELETE "$BASE/<id>" -H "Authorization: Bearer $TOKEN"
```

## Notes

- A **collection** is a named group of artifacts you can scope a chat to in the
  app. Reference it by **name** (created automatically if missing) or by **id**.
  Collection tagging here is **additive** — to remove a tag, manage it in the
  app.
- Setting `visibility` to `unlisted`/`public` returns a `public_slug`. For an
  `html` artifact you also get a `share_url` — a clean standalone page served by
  the public `p` function. For other types, build the in‑app link yourself:
  `https://<app-origin>/share/a/<public_slug>`.
- This API is intentionally close to the MCP `create_artifact` /
  `add_to_collection` tools — same data model — but reachable with a plain
  `curl`, so non‑Claude systems can push and sync content too.
