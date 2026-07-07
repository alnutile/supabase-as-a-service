-- Events + Event Listeners — a workspace-wide pub/sub substrate for automation.
--
-- The idea (a "core feature"): every meaningful thing that happens in the
-- workspace — an artifact created, a file added, a to-do completed, a message
-- received, an item filed into a collection — emits an `events` row. A user then
-- creates `event_listeners` ("when a file is added to the 'Fubar' collection, run
-- this agent"), and a background dispatcher (the `event-dispatch` edge function,
-- ticked by pg_cron like the scheduler) matches new events to active listeners
-- and runs their action. Each dispatch is recorded in `event_listener_runs`.
--
-- This is deliberately SEPARATE from `activity_log`:
--   * `activity_log` is the human-facing feed (owner/admin-scoped, "here's what
--     happened"). It stays exactly as-is.
--   * `events` is the machine-facing automation stream — it carries a stable
--     `entity_type`/`entity_id`, a `processed_at` dispatch cursor, and workspace
--     visibility so listeners can safely react to shared activity.
--
-- Emit paths mirror the two the codebase already uses: SECURITY DEFINER DB
-- triggers (this file) for record changes, and the service-role edge functions
-- (e.g. `message-inbound`) for things that happen outside Postgres.

-- ---------------------------------------------------------------------------
-- events — the automation stream
-- ---------------------------------------------------------------------------
create table public.events (
  id uuid primary key default gen_random_uuid(),
  type text not null,                 -- dotted name, e.g. 'file.created', 'collection.item_added'
  entity_type text,                   -- 'artifact' | 'file' | 'todo' | 'link' | 'message' | 'collection' | 'conversation'
  entity_id uuid,
  actor_id uuid references auth.users (id) on delete set null,
  summary text not null default '',
  data jsonb not null default '{}'::jsonb,
  visibility text not null default 'workspace' check (visibility in ('private', 'workspace')),
  processed_at timestamptz,           -- dispatch cursor: null = not yet dispatched
  created_at timestamptz not null default now()
);
create index events_created_idx on public.events (created_at desc);
create index events_type_idx on public.events (type);
-- The dispatcher scans this hot partial index every minute.
create index events_pending_idx on public.events (created_at) where processed_at is null;

alter table public.events enable row level security;
grant select on public.events to authenticated;

-- Read your own events, any workspace-visible event, or (as an admin) all.
-- Inserts are only ever done by SECURITY DEFINER triggers / the service role,
-- so there is intentionally no INSERT/UPDATE/DELETE policy for API roles.
create policy "Read own or workspace events"
  on public.events for select
  using (
    actor_id = auth.uid()
    or visibility = 'workspace'
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin)
  );

-- Live events feed in the UI.
alter publication supabase_realtime add table public.events;

-- ---------------------------------------------------------------------------
-- emit_event — the single insert helper every trigger / function calls.
-- SECURITY DEFINER so it writes past the (insert-less) RLS; pinned search_path.
-- ---------------------------------------------------------------------------
create or replace function public.emit_event(
  p_type text,
  p_entity_type text,
  p_entity_id uuid,
  p_actor_id uuid,
  p_summary text,
  p_data jsonb default '{}'::jsonb,
  p_visibility text default 'workspace'
) returns void
language plpgsql security definer set search_path = public as $$
begin
  insert into public.events (type, entity_type, entity_id, actor_id, summary, data, visibility)
  values (
    p_type,
    p_entity_type,
    p_entity_id,
    p_actor_id,
    coalesce(p_summary, ''),
    coalesce(p_data, '{}'::jsonb),
    case when p_visibility in ('private', 'workspace') then p_visibility else 'workspace' end
  );
end; $$;
revoke execute on function public.emit_event(text, text, uuid, uuid, text, jsonb, text) from anon, authenticated, public;

-- ---------------------------------------------------------------------------
-- Per-entity trigger functions. Each is SECURITY DEFINER with a pinned
-- search_path, mirroring the existing log_*() triggers in 0007/0008.
-- ---------------------------------------------------------------------------

-- artifacts: created + updated
create or replace function public.emit_artifact_event()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public.emit_event(
    case when tg_op = 'INSERT' then 'artifact.created' else 'artifact.updated' end,
    'artifact', new.id, new.owner_id,
    (case when tg_op = 'INSERT' then 'Artifact created: ' else 'Artifact updated: ' end) || new.title,
    jsonb_build_object('title', new.title, 'type', new.type),
    case when new.visibility = 'private' then 'private' else 'workspace' end
  );
  return new;
end; $$;
create trigger trg_emit_artifact
  after insert or update on public.artifacts
  for each row execute function public.emit_artifact_event();

-- files: created (insert) + deleted (delete)
create or replace function public.emit_file_event()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'DELETE' then
    perform public.emit_event('file.deleted', 'file', old.id, old.owner_id,
      'File deleted: ' || old.name, jsonb_build_object('name', old.name),
      case when old.visibility = 'private' then 'private' else 'workspace' end);
    return old;
  end if;
  perform public.emit_event('file.created', 'file', new.id, new.owner_id,
    'File added: ' || new.name, jsonb_build_object('name', new.name, 'mime_type', new.mime_type),
    case when new.visibility = 'private' then 'private' else 'workspace' end);
  return new;
end; $$;
create trigger trg_emit_file
  after insert or delete on public.files
  for each row execute function public.emit_file_event();

-- todos: created + completed
create or replace function public.emit_todo_event()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    perform public.emit_event('todo.created', 'todo', new.id, new.owner_id,
      'To-do added: ' || new.title,
      jsonb_build_object('title', new.title),
      case when new.visibility = 'private' then 'private' else 'workspace' end);
  elsif new.done and not coalesce(old.done, false) then
    perform public.emit_event('todo.completed', 'todo', new.id, new.owner_id,
      'To-do completed: ' || new.title,
      jsonb_build_object('title', new.title),
      case when new.visibility = 'private' then 'private' else 'workspace' end);
  end if;
  return new;
end; $$;
create trigger trg_emit_todo
  after insert or update on public.todos
  for each row execute function public.emit_todo_event();

-- links: created
create or replace function public.emit_link_event()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public.emit_event('link.created', 'link', new.id, new.owner_id,
    'Link saved: ' || coalesce(nullif(new.title, ''), new.url),
    jsonb_build_object('url', new.url, 'title', new.title),
    case when new.visibility = 'private' then 'private' else 'workspace' end);
  return new;
end; $$;
create trigger trg_emit_link
  after insert on public.links
  for each row execute function public.emit_link_event();

-- conversations: created
create or replace function public.emit_conversation_event()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public.emit_event('chat.created', 'conversation', new.id, new.owner_id,
    'Conversation started: ' || coalesce(nullif(new.title, ''), 'Untitled'),
    jsonb_build_object('title', new.title), 'private');
  return new;
end; $$;
create trigger trg_emit_conversation
  after insert on public.conversations
  for each row execute function public.emit_conversation_event();

-- collection membership: one generic trigger over every collection_* join table.
-- Emits `collection.item_added` carrying the collection + the item that was
-- filed — the event listeners' headline use case ("when X is added to
-- collection Fubar, do Y"). Item type is derived from the join table name and
-- the item id from the matching `<type>_id` column via to_jsonb(new).
create or replace function public.emit_collection_item_added()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_item_type text;
  v_item_id uuid;
  v_owner uuid;
  v_vis text;
begin
  v_item_type := case tg_table_name
    when 'collection_artifacts' then 'artifact'
    when 'collection_files' then 'file'
    when 'collection_todos' then 'todo'
    when 'collection_links' then 'link'
    when 'collection_tables' then 'table'
    when 'collection_inbox_messages' then 'inbox_message'
    else 'item' end;
  v_item_id := (to_jsonb(new) ->> (v_item_type || '_id'))::uuid;
  select owner_id, visibility into v_owner, v_vis from public.collections where id = new.collection_id;
  perform public.emit_event(
    'collection.item_added', v_item_type, v_item_id,
    coalesce(new.added_by, v_owner),
    'Added a ' || v_item_type || ' to a collection',
    jsonb_build_object('collection_id', new.collection_id, 'item_type', v_item_type, 'item_id', v_item_id),
    case when coalesce(v_vis, 'workspace') = 'private' then 'private' else 'workspace' end
  );
  return new;
end; $$;

create trigger trg_emit_collection_artifact
  after insert on public.collection_artifacts
  for each row execute function public.emit_collection_item_added();
create trigger trg_emit_collection_file
  after insert on public.collection_files
  for each row execute function public.emit_collection_item_added();
create trigger trg_emit_collection_todo
  after insert on public.collection_todos
  for each row execute function public.emit_collection_item_added();
create trigger trg_emit_collection_link
  after insert on public.collection_links
  for each row execute function public.emit_collection_item_added();
create trigger trg_emit_collection_table
  after insert on public.collection_tables
  for each row execute function public.emit_collection_item_added();

-- ---------------------------------------------------------------------------
-- event_listeners — the automation rules ("when EVENT, do ACTION")
-- ---------------------------------------------------------------------------
--   event_type : exact ('file.created'), prefix wildcard ('file.*'), or '*' (any)
--   match      : optional narrowing filters, all must hold:
--                { "collection_id": uuid, "entity_type": text, "source": text }
--                (source applies to message.* events)
--   action_type / action_config :
--     run_agent        { "agent_id": uuid, "instructions"?: text }
--     run_tool         { "tool": name|id, "input"?: object }  ({{event}} -> event JSON)
--     add_to_collection{ "collection_id": uuid }              (files the event's entity)
--     log              {}                                     (record only; a safe no-op/test)
create table public.event_listeners (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  is_active boolean not null default true,
  event_type text not null,
  match jsonb not null default '{}'::jsonb,
  action_type text not null check (action_type in ('run_agent', 'run_tool', 'add_to_collection', 'log')),
  action_config jsonb not null default '{}'::jsonb,
  visibility text not null default 'private' check (visibility in ('private', 'workspace')),
  last_run_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index event_listeners_active_idx on public.event_listeners (is_active) where is_active;

alter table public.event_listeners enable row level security;
grant select, insert, update, delete on public.event_listeners to authenticated;

create policy "Read own or shared listeners"
  on public.event_listeners for select
  using (
    owner_id = auth.uid()
    or visibility = 'workspace'
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin)
  );
create policy "Insert own listeners"
  on public.event_listeners for insert
  with check (owner_id = auth.uid());
create policy "Update own or shared listeners"
  on public.event_listeners for update
  using (
    owner_id = auth.uid()
    or visibility = 'workspace'
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin)
  );
create policy "Delete own listeners"
  on public.event_listeners for delete
  using (
    owner_id = auth.uid()
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin)
  );

create trigger event_listeners_set_updated_at
  before update on public.event_listeners
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- event_listener_runs — audit of each dispatch (what a listener did to an event)
-- ---------------------------------------------------------------------------
create table public.event_listener_runs (
  id uuid primary key default gen_random_uuid(),
  listener_id uuid not null references public.event_listeners (id) on delete cascade,
  event_id uuid references public.events (id) on delete set null,
  status text not null default 'ok' check (status in ('ok', 'error', 'skipped')),
  result text,
  error text,
  created_at timestamptz not null default now()
);
create index event_listener_runs_listener_idx on public.event_listener_runs (listener_id, created_at desc);

alter table public.event_listener_runs enable row level security;
grant select on public.event_listener_runs to authenticated;

-- A run is visible to whoever can see its listener (owner / shared / admin).
create policy "Read runs of visible listeners"
  on public.event_listener_runs for select
  using (
    exists (
      select 1 from public.event_listeners l
      where l.id = listener_id
        and (
          l.owner_id = auth.uid()
          or l.visibility = 'workspace'
          or exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin)
        )
    )
  );

alter publication supabase_realtime add table public.event_listener_runs;

-- ---------------------------------------------------------------------------
-- Cron wiring (applied out-of-band against the live project AFTER the
-- `event-dispatch` function is deployed, exactly like the scheduler in
-- 0010_scheduled_agents.sql — a function must exist before cron can call it):
--
--   select cron.schedule('dispatch-events', '* * * * *', $$
--     select net.http_post(
--       url := 'https://<project-ref>.supabase.co/functions/v1/event-dispatch',
--       headers := jsonb_build_object('Content-Type', 'application/json',
--                                     'x-cron-secret', (select secret from public.cron_config limit 1)),
--       body := '{}'::jsonb
--     );
--   $$);
-- ---------------------------------------------------------------------------
