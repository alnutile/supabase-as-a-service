# Events, listeners & the unified inbox

Two connected features (migrations `0060_events.sql` + `0061_messages.sql`):

- **Events + event listeners** — a workspace pub/sub automation substrate.
- **Unified inbox** — one place for messages from any source (email, Slack,
  WhatsApp, generic pushes), which themselves emit events.

## Events

Every meaningful record change emits a row into `public.events` via SECURITY
DEFINER DB triggers calling the `emit_event(...)` helper:

| Event type | Fires when |
| --- | --- |
| `artifact.created` / `artifact.updated` | an artifact is inserted / updated |
| `file.created` / `file.deleted` | a file row is inserted / deleted |
| `todo.created` / `todo.completed` | a to-do is added / checked off |
| `link.created` | a link is saved |
| `chat.created` | a conversation is started |
| `message.received` | an inbox message arrives (any source) |
| `collection.item_added` | any item is filed into a collection |

Each event carries `entity_type`, `entity_id`, `actor_id`, a `data` jsonb
(e.g. `{collection_id, item_type, item_id}` for `collection.item_added`,
`{source, from_address, subject}` for `message.received`), `visibility`
(so listeners only react to what the owner may see), and a `processed_at`
dispatch cursor. The live feed is **Events** (`/events`).

`events` is separate from `activity_log` on purpose: `activity_log` stays the
human "what happened" feed; `events` is the machine stream automations run on.

## Listeners

An `event_listeners` row is a rule managed on the **Listeners** page
(`/listeners`):

- **Event** — exact (`file.created`), prefix wildcard (`file.*`), or `*` (any).
- **Filters** (`match` jsonb, all optional): `entity_type`, `collection_id`,
  `source`.
- **Action**:
  - `run_agent` — run an agent over the event (same loop as the scheduler).
  - `run_tool` — call one tool directly (no model); `{{event}}` in the input is
    replaced with the event JSON.
  - `add_to_collection` — file the event's entity into a collection.
  - `log` — record the match only (a safe way to test a rule).

Example: *"When a file is added to the **Fubar** collection, run the **Summarizer**
agent"* → event `collection.item_added`, match `{collection_id: <Fubar>, entity_type: file}`,
action `run_agent` with that agent.

Each dispatch is recorded in `event_listener_runs` (shown under the listener) and
logged to `activity_log` as `listener.run` / `listener.error`.

## Dispatcher cron (one-time setup)

The `event-dispatch` edge function does the matching + running. Like the
`scheduler`, it is **not** auto-scheduled — after the function is deployed, wire
pg_cron once against the live project (same convention as `0010_scheduled_agents.sql`):

```sql
select cron.schedule('dispatch-events', '* * * * *', $$
  select net.http_post(
    url := 'https://<project-ref>.supabase.co/functions/v1/event-dispatch',
    headers := jsonb_build_object('Content-Type', 'application/json',
                                  'x-cron-secret', (select secret from public.cron_config limit 1)),
    body := '{}'::jsonb
  );
$$);
```

Until this runs, events still accumulate (and show in the feed) but listeners
don't fire. Safety: each event is claimed once (`processed_at`), and each tick
caps how many actions it runs, so chained automations stay bounded.

## Unified inbox

`inbox_messages` (generalized from the old email-only table) is the one inbox.
The **Inbox** page (`/inbox`) lists and filters by source, marks read, files
messages into collections, and composes manual messages.

### Ingestion

- **Email** — providers POST to `email-inbound` (unchanged setup, see
  `docs/slack.md`-style flow); rows land with `source='email'`, workspace-shared.
- **Anything else** — POST to the token-gated `message-inbound` function:

  ```bash
  curl -X POST 'https://<project-ref>.supabase.co/functions/v1/message-inbound' \
    -H 'Authorization: Bearer <connect-claude-token>' \
    -H 'Content-Type: application/json' \
    -d '{
      "source": "slack",
      "from": "Jane <jane@x.com>",
      "subject": "deploy finished",
      "body": "prod is green",
      "url": "https://slack.com/...",
      "external_id": "slack-msg-123"
    }'
  ```

  Auth is a personal `mcp_tokens` bearer (Settings → Connect Claude / the API
  page) or a Supabase session JWT — the same credential as `run-tool`. `body` is
  the only required field; `external_id` dedupes re-deliveries per source.

- **The assistant / agents** — seeded builtins `save_message`, `list_messages`,
  `add_message_to_collection` (usable in chat, agents, and via `run-tool`).

- **IMAP mailbox (pull, migration 0062)** — connect a real mailbox and have it
  polled into this table. In **Settings → Email accounts (IMAP)** any member adds
  an account (host / port / username / app-password, folder, private-or-workspace
  visibility, poll interval). The password lives only in Supabase Vault (written
  via `set_imap_account`, read only by the service role via `read_imap_secret`).

  Because an edge function can't hold a live IMAP socket open, the public
  **`imap-poll`** function (`verify_jwt: false`) does a short poll-and-disconnect
  over `Deno.connectTls` — LOGIN → SELECT → `UID SEARCH` for mail newer than the
  account's UID cursor → `UID FETCH` a bounded batch → parse with `postal-mime` →
  insert (`source='email'`, dedup on `(source, external_id)` = the Message-ID) →
  optionally flag `\Seen` → LOGOUT. It runs two ways:

  - **Cron** — pg_cron ticks it every minute with the `x-cron-secret` (same gate
    as the scheduler; wire it out-of-band after deploy, mirroring the block in
    `0062_imap_accounts.sql`) and it polls every account whose `next_poll_at` is due.
  - **Poll now** — an authenticated owner POSTs `{account_id}` (session JWT or an
    `mcp_tokens` bearer, verified in code) to poll one account immediately; the
    Settings card's "Poll now" button uses this and doubles as a connection test.

  The wire client + pure parsers live in `supabase/functions/_shared/imap.ts` and
  are unit-tested in `tests/imap_test.ts`.

A `message.received` event fires on every insert, so an inbound message can drive
a listener (e.g. *"when a WhatsApp message arrives, add it to the Support
collection"*).

*Planned:* Google/Microsoft OAuth account connectors that funnel into this table;
injecting a collection's messages into `loadCollectionsContext`; a REST API + MCP
tools like artifacts/to-dos.
