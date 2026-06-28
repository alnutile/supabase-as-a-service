# To-dos API

A small, plain-REST CRUD API around **to-dos** so you can capture and sync tasks
into this workspace from anywhere — a script, a Zap, a cron job, another app —
without speaking MCP or holding a Supabase session. It's the sibling of the
[Artifacts API](./artifacts-api.md) and shares its auth model.

Every to-do can be **tagged into collections** (the same named groups you chat
with in the app), so a collection can carry tasks alongside its docs.

## Auth

Send a per-user **bearer token** in the `Authorization` header:

```
Authorization: Bearer <token>
```

The token is a personal connection token — mint one in the app under
**Settings → Connect Claude** (the same `mcp_tokens` used for MCP and the
Artifacts API). The function runs with the service role but re-enforces ownership
in code from the token → owner mapping: **you only ever see and modify your own
to-dos.** Treat a token like a password; revoke it in Settings if it leaks.

## Base URL

```
https://<your-project>.supabase.co/functions/v1/todos
```

`GET /todos` with no `Authorization` header — or `GET /todos/docs` — returns these
docs as plain text, straight from the endpoint.

## Endpoints

| Method | Path | Description |
| --- | --- | --- |
| GET | `/todos` | List your to-dos (filters below). |
| POST | `/todos` | Create a to-do. |
| GET | `/todos/:id` | Read one, including its collections. |
| PATCH/PUT | `/todos/:id` | Update only the fields you send (`done:true` completes it); collection tags are added. |
| DELETE | `/todos/:id` | Delete one. |

## GET /todos

Query params:

- `collection=<name|id>` — only to-dos in this collection.
- `status=open|done` — filter by completion state.
- `q=<text>` — title contains (case-insensitive).
- `sort=position|due` — `position` (default) is your manual drag order; `due` sorts by due date.
- `limit=<1-200>` (default 100), `offset=<n>` — paging.

Response:

```json
{
  "todos": [
    {
      "id": "…",
      "title": "Ship the thing",
      "notes": "",
      "due_date": "2026-07-01",
      "done": false,
      "completed_at": null,
      "position": 0,
      "visibility": "private",
      "created_at": "…",
      "updated_at": "…"
    }
  ],
  "count": 1
}
```

## POST /todos

Body:

```json
{
  "title": "Ship the thing",     // required
  "notes": "optional details",   // optional
  "due_date": "2026-07-01",      // optional, YYYY-MM-DD
  "done": false,                  // optional
  "visibility": "private",       // private (default) | workspace
  "collection": "Work",          // optional name or id — created if missing
  "collections": ["Work", "Q3"]  // optional list, same rules
}
```

Returns `201` with the created to-do and the `collections` it was filed into.

## GET /todos/:id

Returns the to-do plus a `collections` array (the collection names it belongs to
that you can see).

## PATCH /todos/:id (or PUT)

Updates only the fields you send. `done:true` marks it complete (and stamps
`completed_at`); `done:false` reopens it. `due_date` accepts `YYYY-MM-DD` or `null`
to clear. Passing `collection`/`collections` **adds** the to-do to them (existing
tags are kept, not replaced).

## DELETE /todos/:id

```json
{ "deleted": true, "id": "…" }
```

## Errors

Errors are JSON: `{ "error": "message" }` with an appropriate status (`400`
invalid body, `401` bad/missing token, `404` not found, `500` server error).

## Notes

- `visibility` is `private` (only you + admins) or `workspace` (the whole team can
  see **and** collaborate — check off / edit), the same model as collections.
- A collection is referenced by **name** (created automatically if missing) or by
  **id**. This mirrors the Artifacts API exactly, so the same collection can hold
  both artifacts and to-dos.
- `position` is your manual drag-sort order in the app (`sort=position`); the API
  exposes it read-mostly — set it explicitly on update if you want, or use the app
  to reorder.

## Examples

```bash
# Create a to-do due next week and tag it into "Work"
curl -X POST "$BASE/todos" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"title":"Ship the thing","due_date":"2026-07-01","collection":"Work"}'

# List open to-dos in a collection, by due date
curl "$BASE/todos?collection=Work&status=open&sort=due" \
  -H "Authorization: Bearer $TOKEN"

# Mark one done
curl -X PATCH "$BASE/todos/<id>" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"done":true}'

# Delete
curl -X DELETE "$BASE/todos/<id>" -H "Authorization: Bearer $TOKEN"
```
