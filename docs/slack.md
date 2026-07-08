# Slack bot — rooms bound to collections

Add the workspace bot to a Slack channel, bind that channel to one or more
collections (and optionally an agent), and anyone in the room can `@mention`
it to get answers grounded in that room's content — the project's docs,
files, to-dos and links. One room = one context, Claude-Tag style.

## How it works

```
Slack (app_mention)
  └─► slack-events edge function (public, signature-verified)
        1. verify the X-Slack-Signature HMAC (signing secret from Vault)
        2. answer url_verification challenges
        3. dedupe on event_id (Slack retries on slow acks)
        4. ack 200 within 3s, then in the background:
             binding = slack_channel_bindings[channel_id]
             system  = agent.instructions (or a default) + loadCollectionsContext(...)
             guardrails (webhook context, fail closed)
             agent loop (tools only when the binding sets allow_tools)
             chat.postMessage → reply in the thread
```

The binding's **creator is the identity the bot runs as** (like
`webhooks.owner_id`): collections context and builtin tools re-enforce that
user's access in code. Bind `workspace`-visibility collections for team rooms
so answers only draw on content every member can already see.

Everything is auditable: `slack_events` (admin-readable) records who asked
what and the outcome (`received → ok / error / blocked / skipped`), replies
log to `activity_log` (`slack.reply`), and every model call writes a
`usage_events` row with `context = 'slack'` for the Usage page.

## Setup

1. **Create the Slack app** at <https://api.slack.com/apps> → *Create New App*
   → *From a manifest*, and paste the manifest below (fill in your project
   ref). Install it to your workspace and copy the **Bot User OAuth Token**
   (`xoxb-…`, *OAuth & Permissions*) and the **Signing Secret**
   (*Basic Information*).
2. **Connect it in the app**: Settings → Slack (admin-only) → paste the bot
   token + signing secret. They are stored in Supabase Vault via the
   `set_slack_integration` RPC — never in a table column or the browser.
3. **Enable events**: in the Slack app's *Event Subscriptions*, set the
   Request URL to `https://<project-ref>.supabase.co/functions/v1/slack-events`
   (shown with a copy button in Settings once connected). Slack sends a
   challenge; it verifies immediately since the function is already deployed
   and the signing secret saved. Subscribe to the `app_mention` bot event.
4. **Bind a room**: `/invite @YourBot` in the channel, grab the channel ID
   (channel details → About → Channel ID), then Settings → Slack →
   *Bind a channel*: pick the collections (and optionally an agent, plus
   whether its tools may run).
5. Mention the bot: `@YourBot what's the latest on the launch checklist?`

## App manifest

```yaml
display_information:
  name: Workspace Assistant
  description: Answers with the room's collection context.
features:
  bot_user:
    display_name: assistant
    always_online: true
oauth_config:
  scopes:
    bot:
      - app_mentions:read   # receive @mentions
      - chat:write          # post replies
      - channels:history    # thread/channel transcript (public channels)
      - groups:history      # same, for private channels it's invited to
      - users:read          # display names in the transcript
settings:
  event_subscriptions:
    request_url: https://<project-ref>.supabase.co/functions/v1/slack-events
    bot_events:
      - app_mention
      - message.channels   # ambient mode: all messages in public channels
      - message.groups     # ambient mode: all messages in private channels
  org_deploy_enabled: false
  socket_mode_enabled: false
  token_rotation_enabled: false
```

The `message.channels`/`message.groups` subscriptions are only needed for
**ambient mode** (below). If you only ever want mention-only behavior you can
drop them — the bot ignores non-mention messages in non-ambient channels anyway.

## Ambient mode (Claude-Tag style)

By default the bot is mention-only. A binding can instead be set to **ambient**
(Settings → Slack → *Bind a channel* → "Ambient mode"), where the bot reads
every message in the channel and a cheap model decides whether to chime in
without being mentioned.

How a channel message is handled when the binding is ambient:

1. **Absorb** — the message is saved into the unified Inbox (`inbox_messages`,
   `source='slack'`) when *Save messages to the inbox* is on, so channel traffic
   is searchable, filable into collections, and can drive event listeners — even
   if the bot stays silent.
2. **Skip mentions** — if the message @mentions the bot, the separate
   `app_mention` event handles the reply (no double answer).
3. **Pre-filter** — trivial/reaction messages (emoji, "lol", bare links) are
   dropped before any model call, so busy channels stay cheap.
4. **Decide** — one call to the binding's **decision model** (any OpenRouter
   slug, e.g. `anthropic/claude-haiku-4.5`; blank = the workspace `utility`
   profile) using the channel's **participation prompt** ("chime in on billing
   questions; stay quiet for banter") returns a strict-JSON `{respond, reason}`.
   It **fails silent** — if the check errors or is unparseable, the bot stays
   quiet (spamming a channel is worse than missing one).
5. **Reply** — on `respond: true` it runs the exact same guardrails + agent loop
   + in-thread reply as an @mention.

Cost/noise notes: ambient is **opt-in per channel** — existing mention-only
bindings are untouched. The pre-filter + the "default to silent" prompt + the
cheap decision model keep it affordable, but a very busy ambient channel will
make one cheap model call per non-trivial message. Point the decision model at
Haiku (or any cheaper OpenRouter model) to tune the bill.

## Security notes

- The endpoint is public (`verify_jwt: false`) but every request must carry a
  valid `X-Slack-Signature` HMAC computed with the signing secret, checked
  with a constant-time compare and a ±5-minute replay window — there is no
  URL token to leak.
- Bot messages and message-edit subtypes are ignored, so the bot can never
  answer itself in a loop; duplicate deliveries are dropped on the unique
  `event_id`.
- Guardrails run in the `webhook` context and **fail closed** — Slack rooms
  are multi-user, semi-trusted input, same posture as inbound webhooks.
- Tools are off by default per binding (`allow_tools`), mirroring
  `webhooks.allow_tools`: an untrusted room can't make the agent act unless
  an admin opts that room in.

## Not built yet (follow-ups)

- DMs to the bot (`message.im`) answering with the DM-er's own context.
- A `send_slack_message` builtin so scheduled agents can post proactive
  updates into bound rooms.
- In-channel binding management (`@bot use collection "Acme"`).
- A per-thread cooldown / rate cap for ambient channels, and resolving Slack
  display names on captured inbox messages (they store the raw user id today).
