# Task: Email as a foundational capability (send + check), credentials in Vault

## Context

This app is a team intranet on Supabase with tools-as-data: the `tools` table defines
what the assistant can do (`kind` = `web` | `http` | `builtin`), and the chat edge
function (`supabase/functions/chat/index.ts`) runs an agentic loop that executes them.
The one existing builtin is `search_documents` (`runBuiltin()`); webhook- and
scheduler-triggered agent loops (`supabase/functions/webhook/index.ts`,
`supabase/functions/scheduler/index.ts`) currently execute only `http` tools.

**The problem:** agents can't touch email. The target experience: an admin configures
email once in Settings, and from then on any user or agent just *uses* it — "email me
a summary every morning" — without anyone explaining providers, keys, or SMTP.

**The goal:** two seeded builtin tools, `send_email` and `check_email`, with all
credentials stored in **Supabase Vault** (never in regular table columns, never in the
browser), configured through a Settings card.

## Design decisions (already made — don't relitigate)

- **Sending goes through HTTP email providers** — Postmark and Resend in v1 — not raw
  SMTP. Stateful SMTP connections from short-lived edge functions are fragile and the
  Deno client libraries are immature; every serious provider has a clean HTTP API.
  Raw SMTP can be a later provider behind the same interface.
- **Receiving is inbound-parse, not IMAP polling.** The provider (Postmark inbound /
  Resend inbound / Mailgun routes) POSTs each incoming email to a public endpoint; we
  store it in an `inbox_messages` table; the `check_email` tool reads that table.
  IMAP is a stateful TCP protocol that doesn't fit edge functions, and polling loses
  to push anyway. The capability is "check email"; the protocol is nobody's business.
- **Secrets live in Vault.** The client writes them only through an admin-gated,
  security-definer RPC; edge functions read `vault.decrypted_secrets` with the service
  role. No secret value is ever readable through PostgREST or returned to the UI.
- **One workspace email integration** (not per-user) in v1, managed by admins.
- `send_email` is an **exfiltration-capable tool**: it gets an optional recipient
  allowlist, a rate limit, and an activity-log entry on every send. (It also composes
  with the guardrails task's `webhooks.allow_tools` gate, since it's just a tool.)

## Requirements

### 1. Schema (new migration, next number in `supabase/migrations/`)

- `create extension if not exists supabase_vault;` (if the project template doesn't
  already have it — check before adding).
- **`public.integrations`** — non-secret config + pointers to Vault secrets:

  ```sql
  create table public.integrations (
    id uuid primary key default gen_random_uuid(),
    kind text not null unique check (kind in ('email')),
    provider text not null check (provider in ('postmark', 'resend')),
    from_address text not null,
    inbound_token text unique,             -- opaque token for the inbound endpoint
    allowed_recipients text[],             -- null = anyone; else exact addresses and/or '@domain.com' suffixes
    secret_id uuid not null,               -- vault.secrets.id holding the provider API key
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  );
  ```

  RLS: admins manage (mirror `tools`' admin policies); authenticated users may SELECT
  only non-sensitive presence info — simplest is a `security_invoker` view or an RPC
  like `email_is_configured()` returning boolean; do **not** expose `secret_id` or
  `inbound_token` to non-admins.
- **RPC `set_email_integration(provider, from_address, api_key, allowed_recipients)`**
  — `security definer`, pinned `search_path`, **admin-checked inside the function
  body** (raise if `profiles.is_admin` is false for `auth.uid()`). Creates/updates the
  Vault secret via `vault.create_secret()` / `vault.update_secret()`, upserts the
  `integrations` row (generating `inbound_token` on first insert), and never returns
  the key. Revoke execute from `anon`; grant to `authenticated` (the body enforces
  admin).
- **`public.inbox_messages`**:

  ```sql
  create table public.inbox_messages (
    id uuid primary key default gen_random_uuid(),
    from_address text not null,
    to_address text,
    subject text not null default '',
    body_text text not null default '',
    received_at timestamptz not null default now(),
    read_at timestamptz,
    raw jsonb                              -- provider payload minus large parts
  );
  ```

  RLS: admins read/update; no client insert (the edge function writes with service
  role). Note in comments: this is a shared workspace inbox — point a *dedicated*
  address at it, not a personal mailbox.
- **Seed two `tools` rows** (kind `builtin`, `is_builtin = true`, `is_active = true`),
  following the `search_documents` seed style in `0012_pdf_knowledge.sql`:
  - `send_email` — description: "Send an email from the workspace. Use when the user
    asks to email someone or to send themselves something." `input_schema`:
    `{ to: string (required), subject: string (required), body: string (required, plain text) }`.
  - `check_email` — description: "Check the workspace inbox for recent incoming
    email." `input_schema`:
    `{ unread_only?: boolean (default true), limit?: integer (default 10, max 25), mark_read?: boolean (default false) }`.

### 2. Shared builtin executor (`supabase/functions/_shared/builtins.ts`)

Move/centralize builtin execution so **all three loops** (chat, webhook, scheduler)
can run builtins — today only chat does, and the "morning agent emails me" flow runs
through the **scheduler**, so this is load-bearing, not a refactor nicety.

- `runBuiltin(db, name, input, userId)` handling `search_documents` (moved from
  chat/index.ts unchanged), `send_email`, `check_email`. Unknown name → the existing
  "Unknown builtin" string.
- **`send_email`:**
  1. Load the `email` integration row (service role); none → return
     "Email isn't configured. An admin can set it up in Settings → Email."
  2. Enforce `allowed_recipients` if set (exact match or `@domain` suffix); reject
     with a clear message otherwise.
  3. Rate limit: max 20 sends per rolling hour per workspace — count recent
     `activity_log` rows of type `email.sent`; refuse politely over the cap.
  4. Read the API key from `vault.decrypted_secrets` by `secret_id`.
  5. POST to the provider (Postmark `https://api.postmarkapp.com/email` with
     `X-Postmark-Server-Token`; Resend `https://api.resend.com/emails` with bearer) —
     from `from_address`, plain-text body.
  6. Log `activity_log` type `email.sent`, summary "Emailed ‹to›: ‹subject›",
     `actor_id` = the calling user (or webhook/schedule owner). Return a short
     success/failure string to the model.
- **`check_email`:** query `inbox_messages` (newest first, honoring `unread_only` /
  `limit`), optionally set `read_at` when `mark_read`, and return a compact text
  digest (from, subject, date, first ~500 chars of body each). Empty → say so.
- Update `chat/index.ts` to use the shared module; add builtin execution branches to
  the tool loops in `webhook/index.ts` and `scheduler/index.ts` (where they currently
  fall through to "Unknown tool" for non-http tools).

### 3. Inbound endpoint (`supabase/functions/email-inbound/index.ts`, `verify_jwt: false`)

- POST-only, token-gated: `/functions/v1/email-inbound/<inbound_token>` (reuse the
  token-extraction pattern from `webhook/index.ts`). Token mismatch → 401.
- Normalize Postmark and Resend inbound payload shapes into an `inbox_messages` row
  (from, to, subject, text body; strip attachments — store names in `raw` only;
  cap `body_text` at ~50k chars).
- Log `activity_log` type `email.received`, summary "Email from ‹from›: ‹subject›".
- Register the function with `verify_jwt = false` the same way `webhook` is.

### 4. Settings UI (`src/pages/SettingsPage.tsx`)

- New admin-only **Email** card:
  - Provider select (Postmark / Resend), from-address input, API-key input
    (**write-only**: never prefilled, placeholder "••• configured" once set),
    optional allowed-recipients list, Save → calls the `set_email_integration` RPC.
  - Once configured, show the inbound address instructions: the
    `/functions/v1/email-inbound/‹token›` URL with one line each for where to paste
    it in Postmark (inbound webhook URL) and Resend (inbound endpoint), plus a copy
    button.
- No inbox UI in this pass — the inbox is read through the `check_email` tool.

### 5. Types & docs

- `src/lib/database.types.ts`: `integrations`, `inbox_messages`, and the RPC if typed.
- CLAUDE.md: a short "Email" paragraph — the two builtins, Vault storage, the inbound
  endpoint, the shared builtins module. README: one feature bullet ("📧 agents can
  send and check email — configure a provider once in Settings").

## Acceptance criteria

1. Admin saves a Postmark key in Settings → the key exists only in Vault (no table
   column, no PostgREST exposure, not visible in the UI after save), and
   `integrations` has the row.
2. In chat: "email me a one-line test at ‹address›" → the email arrives, and
   `email.sent` appears in the Activity feed.
3. A **scheduled agent** whose tools include `send_email` sends mail when the
   scheduler ticks it (proves the shared-builtins wiring beyond chat).
4. With `allowed_recipients = ['@mycompany.com']`, sending to an outside address is
   refused with a clear message; the 21st send within an hour is refused.
5. An email sent to the provider's inbound address shows up via `check_email` in chat
   within seconds (no polling), and `mark_read` works.
6. With no integration configured, `send_email`/`check_email` return the friendly
   "ask an admin" message — no errors, no crashes.
7. A non-admin cannot read `integrations` secrets/tokens or call the RPC
   successfully; the inbound endpoint rejects bad tokens with 401.
8. `npm run build` and `npm run lint` pass.

## Out of scope (do not build now)

IMAP/POP3/raw SMTP, per-user mailboxes or sending identities, HTML email composition,
outbound attachments, inbound attachment storage, an inbox page in the UI, reply
threading, additional providers (SendGrid/Mailgun/SES), email-triggered agents
(that's a natural follow-up: a trigger that runs an agent per `inbox_messages` row —
note it in CLAUDE.md as planned, don't build it).

## Constraints

- Secrets touch exactly two places: Vault (storage) and edge-function memory (use).
  Never a table column, never a client payload, never a log line.
- RLS + the admin check inside the RPC are the security boundary; UI gating is
  cosmetic.
- `send_email` must remain an ordinary tool row so existing controls apply to it
  (admin activation, agent `tool_ids` scoping, and the guardrails task's
  `webhooks.allow_tools` gate).
- Follow existing migration style (comments, pinned `search_path`, explicit revokes)
  and the existing edge-function patterns (CORS block, `json()` helper, token
  extraction).
