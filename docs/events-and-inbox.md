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

A `message.received` event fires on every insert, so an inbound message can drive
a listener (e.g. *"when a WhatsApp message arrives, add it to the Support
collection"*).

### IMAP email accounts ("Add an inbox")

Instead of a provider push, you can **add an IMAP mailbox** that the workspace
polls (migration `0102`). New mail lands in `inbox_messages` (`source='email'`)
and fires `message.received` — so from the **Listeners** page you route it exactly
like a webhook (e.g. *"drop each new email into the `logs` table"* via `run_tool:
add_table_row`). You enter the mailbox's connection details once; the password is
stored encrypted in Supabase Vault, never shown again.

**Where:** Inbox → **Inboxes** (top-right) → **Add inbox** (`/inbox/accounts`).
A mailbox is `private` (mail visible only to you) or `workspace` (shared with the
team), mirroring links/todos. Provider presets fill host/port for you.

**Test without waiting:** the editor has a **Test connection** button (the
`imap-test` edge function, `verify_jwt=true`) that logs in and reports the folder's
message count, so you can validate an app password before saving. Each saved inbox
also has a **Test message** button that inserts a synthetic `source='email'` row —
firing `message.received` — so you can wire and verify a Listener end-to-end without
waiting for real mail. (A fresh inbox is also polled on the next 1-minute tick, not
after its full interval, since it has no `last_checked_at` yet.)

**How it runs:** the `email-poll` edge function is cron-ticked every minute (added
to `_automation_cron_jobs()`, so every tenant self-schedules it — no manual step),
but each mailbox is only checked at most once per its **Check every N minutes**
setting. It opens IMAP over TLS (`Deno.connectTls`), fetches messages with a UID
greater than the last one ingested (a fresh inbox backfills only the ~10 most
recent), and dedupes on `Message-ID`. Any failure is recorded on the account's
`last_error` and shown on the card (with an "error" badge); it never blocks other
mailboxes. RFC822 parsing (headers, MIME text body, base64/quoted-printable) is the
pure, unit-tested `supabase/functions/_shared/imap.ts` (`tests/imap_test.ts`).

> If your Supabase project's egress blocks outbound port 993, the poll will report
> a connect error — fall back to a provider inbound-parse (`email-inbound`) or a
> push to `message-inbound`.

**Use an app password, not your real password.** Almost every mail provider now
requires an *app-specific password* for IMAP once two-factor authentication (2FA)
is on — your normal login password will be rejected. The app password lives in the
provider's **2FA / security** area:

- **Gmail / Google Workspace** (covers custom domains on Google, e.g.
  `monitoring@yourdomain.com`):
  1. Turn on **2-Step Verification** — the *App passwords* option only appears
     after 2FA is enabled. Google Account → **Security** → *2-Step Verification*.
  2. Google Account → **Security** → **App passwords** → generate one for "Mail".
     You get a 16-character code (shown without spaces) — that is the password you
     paste into the inbox form.
  3. IMAP is on by default for most accounts; if not, Gmail → Settings → *Forwarding
     and POP/IMAP* → **Enable IMAP**.
- **Microsoft / Outlook.com** — Account security → *Advanced security options* →
  **App passwords** (requires 2FA). Note: many Microsoft 365 **org** tenants disable
  basic-auth/IMAP entirely and only allow OAuth — those can't use this connector yet
  (OAuth is a later connector type).
- **Yahoo** — Account Security → **Generate app password**.
- **iCloud** — appleid.apple.com → Sign-In and Security → **App-Specific Passwords**.
- **Custom domain on another host** (cPanel, Fastmail, etc.) — use the mailbox
  password or an app password from that host's control panel.

**Typical IMAP settings:**

| Provider | Host | Port | Security | Username |
| --- | --- | --- | --- | --- |
| Gmail / Google Workspace | `imap.gmail.com` | `993` | SSL/TLS | full email address |
| Outlook.com / Microsoft 365 | `outlook.office365.com` | `993` | SSL/TLS | full email address |
| Yahoo | `imap.mail.yahoo.com` | `993` | SSL/TLS | full email address |
| iCloud | `imap.mail.me.com` | `993` | SSL/TLS | full email address |
| Fastmail | `imap.fastmail.com` | `993` | SSL/TLS | full email address |
| Other / custom | *from your mail host* | `993` (SSL) or `143` (STARTTLS) | SSL/TLS | usually the full email address |

Defaults that work almost everywhere: **port 993, SSL/TLS**, folder **`INBOX`**,
username = the **full email address**. Only fall back to port 143 (STARTTLS) if the
host doesn't offer implicit TLS.

*Planned:* Google/Microsoft **OAuth** account connectors (no app password) on the
same `email_accounts` table; STARTTLS (port 143) support; injecting a collection's
messages into `loadCollectionsContext`; a REST API + MCP tools like artifacts/to-dos.
