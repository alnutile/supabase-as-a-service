-- Unified inbox — one place to push every message, from any source.
--
-- The vision: email, Slack, WhatsApp, and generic "push this to me" messages all
-- land in ONE inbox so a person (and the team, via collections) can read them,
-- chat over them, and build automations on them — all the context in one place.
--
-- We GENERALIZE the existing email-only `inbox_messages` (0016) rather than add a
-- new table (the name `messages` is already taken by chat messages). Today it is
-- admin-only, email-shaped, and has no owner/source/realtime. We add:
--   * owner_id / visibility  → the private-or-workspace model used by
--     links/todos/collections (replacing the admin-only RLS)
--   * source                 → email | slack | whatsapp | sms | webhook | manual | other
--   * from_name / url / external_id  → richer, source-agnostic fields
-- and join it into collections via `collection_inbox_messages` (mirror of
-- collection_links). Combined with 0063, an inserted row emits a
-- `message.received` event that event listeners can automate on.
--
-- Ingestion: `email-inbound` writes email rows here; the token-gated public
-- `message-inbound` function accepts arbitrary pushes (Slack / WhatsApp / Zapier
-- / scripts); the `save_message` builtin lets the assistant + agents capture
-- messages. IMAP/Google/Microsoft account connectors are a later, separate piece
-- — they all just funnel into this table.

-- ---------------------------------------------------------------------------
-- Generalize inbox_messages
-- ---------------------------------------------------------------------------
alter table public.inbox_messages
  add column if not exists owner_id uuid references auth.users (id) on delete cascade,
  add column if not exists source text not null default 'email'
    check (source in ('email', 'slack', 'whatsapp', 'sms', 'webhook', 'manual', 'other')),
  add column if not exists external_id text,
  add column if not exists from_name text not null default '',
  add column if not exists url text,
  add column if not exists visibility text not null default 'private' check (visibility in ('private', 'workspace'));

-- Backfill the pre-existing (email) rows: owned by the first admin, shared
-- workspace-wide (matching the old admin-readable inbox).
update public.inbox_messages
set owner_id = coalesce(owner_id, (select id from public.profiles order by created_at asc limit 1)),
    source = 'email',
    visibility = 'workspace'
where owner_id is null;

create index if not exists inbox_messages_owner_idx on public.inbox_messages (owner_id, received_at desc);
create index if not exists inbox_messages_source_idx on public.inbox_messages (source, received_at desc);
-- Dedupe: a given source never stores the same provider id twice.
create unique index if not exists inbox_messages_source_external_idx
  on public.inbox_messages (source, external_id) where external_id is not null;

-- Replace the admin-only RLS with the private/workspace model.
drop policy if exists "Admins read inbox" on public.inbox_messages;
drop policy if exists "Admins update inbox" on public.inbox_messages;
grant insert, delete on public.inbox_messages to authenticated;

create policy "Read own or shared inbox"
  on public.inbox_messages for select
  using (
    owner_id = auth.uid()
    or visibility = 'workspace'
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin)
  );
create policy "Insert own inbox messages"
  on public.inbox_messages for insert
  with check (owner_id = auth.uid());
create policy "Update own or shared inbox"
  on public.inbox_messages for update
  using (
    owner_id = auth.uid()
    or visibility = 'workspace'
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin)
  );
create policy "Delete own inbox messages"
  on public.inbox_messages for delete
  using (
    owner_id = auth.uid()
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin)
  );

alter publication supabase_realtime add table public.inbox_messages;

-- Every incoming message emits an event so listeners can react (0063).
create or replace function public.emit_message_event()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public.emit_event('message.received', 'inbox_message', new.id, new.owner_id,
    coalesce(nullif(new.subject, ''), nullif(new.from_address, ''), 'New message'),
    jsonb_build_object('source', new.source, 'from_address', new.from_address, 'subject', new.subject),
    new.visibility);
  return new;
end; $$;
create trigger trg_emit_message
  after insert on public.inbox_messages
  for each row execute function public.emit_message_event();

-- ---------------------------------------------------------------------------
-- collection_inbox_messages (many-to-many; mirrors collection_links exactly)
-- ---------------------------------------------------------------------------
create table public.collection_inbox_messages (
  collection_id uuid not null references public.collections (id) on delete cascade,
  inbox_message_id uuid not null references public.inbox_messages (id) on delete cascade,
  added_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (collection_id, inbox_message_id)
);
create index collection_inbox_messages_msg_idx on public.collection_inbox_messages (inbox_message_id);

alter table public.collection_inbox_messages enable row level security;
grant select, insert, delete on public.collection_inbox_messages to authenticated;

create policy "Read inbox memberships of visible collections"
  on public.collection_inbox_messages for select
  using (exists (select 1 from public.collections c where c.id = collection_id));

create policy "Add inbox messages to collaborable collections"
  on public.collection_inbox_messages for insert
  with check (
    exists (
      select 1 from public.collections c
      where c.id = collection_id
        and (
          c.owner_id = auth.uid()
          or c.visibility = 'workspace'
          or exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin)
        )
    )
  );

create policy "Remove inbox messages from collaborable collections"
  on public.collection_inbox_messages for delete
  using (
    exists (
      select 1 from public.collections c
      where c.id = collection_id
        and (
          c.owner_id = auth.uid()
          or c.visibility = 'workspace'
          or exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin)
        )
    )
  );

-- Emit collection.item_added for inbox messages too (0063's generic trigger fn).
create trigger trg_emit_collection_inbox_message
  after insert on public.collection_inbox_messages
  for each row execute function public.emit_collection_item_added();

-- ---------------------------------------------------------------------------
-- Seed the message builtins (assistant + all three agent loops + run-tool).
-- Same insert shape as the link builtins in 0049_links.sql; idempotent.
-- ---------------------------------------------------------------------------
insert into public.tools (name, description, input_schema, kind, is_builtin, is_active, created_by)
select 'save_message',
  'Save a message into the unified inbox (a captured message from any source — a note, a forwarded email, a Slack/WhatsApp message, etc.). Optionally file it into a collection (by name; created if missing).',
  '{"type":"object","properties":{"body":{"type":"string","description":"The message body/content."},"subject":{"type":"string","description":"Optional subject/title."},"from":{"type":"string","description":"Who it is from (name, email, handle, or phone)."},"source":{"type":"string","enum":["email","slack","whatsapp","sms","webhook","manual","other"],"description":"Where it came from (default manual)."},"url":{"type":"string","description":"Optional link back to the original."},"collection":{"type":"string","description":"Optional collection name (or id) to file it into; created if missing."}},"required":["body"]}'::jsonb,
  'builtin', true, true,
  (select id from public.profiles order by created_at asc limit 1)
where not exists (select 1 from public.tools where name = 'save_message');

insert into public.tools (name, description, input_schema, kind, is_builtin, is_active, created_by)
select 'list_messages',
  'List messages from the unified inbox. Optionally filter by source (email/slack/whatsapp/...), by collection (name/id), or only unread.',
  '{"type":"object","properties":{"source":{"type":"string","description":"Optional source filter."},"collection":{"type":"string","description":"Optional collection name or id to filter by."},"unread_only":{"type":"boolean","description":"Only unread messages (default false)."},"limit":{"type":"number","description":"Max messages to return (default 20, max 50)."}}}'::jsonb,
  'builtin', true, true,
  (select id from public.profiles order by created_at asc limit 1)
where not exists (select 1 from public.tools where name = 'list_messages');

insert into public.tools (name, description, input_schema, kind, is_builtin, is_active, created_by)
select 'add_message_to_collection',
  'Add an existing inbox message to a collection (both by name or id). The collection is created if it does not exist.',
  '{"type":"object","properties":{"collection":{"type":"string","description":"Collection name or id."},"message_id":{"type":"string","description":"The inbox message id to add."}},"required":["collection","message_id"]}'::jsonb,
  'builtin', true, true,
  (select id from public.profiles order by created_at asc limit 1)
where not exists (select 1 from public.tools where name = 'add_message_to_collection');
