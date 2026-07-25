-- 0093_table_events.sql
-- Per-table event sourcing + a deterministic webhook -> table target.
--
-- Two capabilities that together let a raw payload flow: webhook lands it in a
-- user table (no AI), the table emits an event, and a listener (deterministic or
-- an AI agent) reacts. This is the "append-only chain" model: each write is a
-- fact that emits a NEW event; nothing morphs a status in place.
--
--   1. user_tables.settings jsonb  — a growing per-table settings bag (first key
--      is emit_events; a stable event_type is minted once and frozen so a rename
--      never breaks a listener wired to it). "Chat with this table" lands here later.
--   2. webhooks.table_id / target_column — a fourth, deterministic webhook target:
--      dump the raw incoming JSON straight into one column of a user table, no model.
--   3. emit_user_table_event() — a generic AFTER INSERT trigger fn that emits a
--      table.<slug>_<id> event carrying the row; attached per-table, opt-in.
--   4. set_user_table_events() / emit_test_table_event() — owner-gated
--      security-definer RPCs to toggle the trigger and to preview the event shape.

-- 1. Growing per-table settings bag ------------------------------------------
alter table public.user_tables
  add column if not exists settings jsonb not null default '{}'::jsonb;

-- 2. Deterministic webhook -> table target -----------------------------------
alter table public.webhooks
  add column if not exists table_id uuid references public.user_tables (id) on delete set null;
alter table public.webhooks
  add column if not exists target_column text;

-- 3. Generic emit trigger function -------------------------------------------
-- Fires from any event-source user table. Looks the registry row up by physical
-- name, emits the table's frozen event_type, and carries the whole row as data.
create or replace function public.emit_user_table_event()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_t public.user_tables%rowtype;
  v_type text;
  v_row jsonb;
  v_id uuid;
begin
  select * into v_t from public.user_tables where physical_name = tg_table_name;
  if not found then
    return coalesce(new, old);
  end if;

  v_type := coalesce(v_t.settings->>'event_type', 'table.' || tg_table_name);

  if tg_op = 'DELETE' then
    v_row := to_jsonb(old);
    v_id := old.id;
  else
    v_row := to_jsonb(new);
    v_id := new.id;
  end if;

  perform public.emit_event(
    v_type,
    'table_row',
    v_id,
    v_t.owner_id,
    v_t.name || ' row ' || lower(tg_op),
    jsonb_build_object(
      'table_id', v_t.id,
      'table_name', v_t.name,
      'physical_name', v_t.physical_name,
      'op', lower(tg_op),
      'row', v_row
    ),
    case when v_t.visibility = 'workspace' then 'workspace' else 'private' end
  );

  return coalesce(new, old);
end;
$$;
revoke execute on function public.emit_user_table_event() from anon, authenticated, public;

-- 4a. Toggle events for one table (attaches/detaches the trigger) -------------
-- Turning events on is DDL, so it lives in a security-definer RPC (mirrors the
-- create_user_table / add_user_column pattern). The event_type is minted once
-- and preserved across off/on toggles so a listener survives a pause.
create or replace function public.set_user_table_events(p_table_id uuid, p_enabled boolean)
returns public.user_tables
language plpgsql
security definer
set search_path = public
as $$
declare
  v_t public.user_tables%rowtype;
  v_event_type text;
  v_slug text;
begin
  select * into v_t from public.user_tables where id = p_table_id;
  if not found then
    raise exception 'Table not found';
  end if;
  if auth.uid() is not null
     and not (v_t.owner_id = auth.uid() or public._is_admin(auth.uid())) then
    raise exception 'Not authorized';
  end if;

  if p_enabled then
    -- Mint a stable, readable event_type once; reuse it forever after.
    v_event_type := v_t.settings->>'event_type';
    if v_event_type is null or v_event_type = '' then
      v_slug := lower(regexp_replace(coalesce(nullif(v_t.name, ''), 'table'), '[^a-zA-Z0-9]+', '_', 'g'));
      v_slug := trim(both '_' from v_slug);
      if v_slug = '' then v_slug := 'table'; end if;
      v_event_type := 'table.' || v_slug || '_' || right(replace(v_t.physical_name, 'ut_', ''), 6);
    end if;

    -- Attach the emit trigger (INSERT only for now — see migration header).
    execute format('drop trigger if exists trg_emit_user_table on public.%I', v_t.physical_name);
    execute format(
      'create trigger trg_emit_user_table after insert on public.%I for each row execute function public.emit_user_table_event()',
      v_t.physical_name
    );

    update public.user_tables
      set settings = jsonb_set(
            coalesce(settings, '{}'::jsonb) || jsonb_build_object('emit_events', true),
            '{event_type}', to_jsonb(v_event_type)
          ),
          updated_at = now()
      where id = p_table_id
      returning * into v_t;
  else
    execute format('drop trigger if exists trg_emit_user_table on public.%I', v_t.physical_name);
    update public.user_tables
      set settings = coalesce(settings, '{}'::jsonb) || jsonb_build_object('emit_events', false),
          updated_at = now()
      where id = p_table_id
      returning * into v_t;
  end if;

  return v_t;
end;
$$;
revoke execute on function public.set_user_table_events(uuid, boolean) from anon, public;
grant execute on function public.set_user_table_events(uuid, boolean) to authenticated, service_role;

-- 4b. Preview the event shape (the "Send test event" button) ------------------
-- Emits a real event (so any listener fires) flagged data.test = true, and
-- returns the event_type + sample data so the UI can show it inline immediately.
create or replace function public.emit_test_table_event(p_table_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_t public.user_tables%rowtype;
  v_type text;
  v_data jsonb;
begin
  select * into v_t from public.user_tables where id = p_table_id;
  if not found then
    raise exception 'Table not found';
  end if;
  if auth.uid() is not null
     and not (v_t.owner_id = auth.uid() or public._is_admin(auth.uid())) then
    raise exception 'Not authorized';
  end if;

  v_type := coalesce(v_t.settings->>'event_type', 'table.' || v_t.physical_name);
  v_data := jsonb_build_object(
    'table_id', v_t.id,
    'table_name', v_t.name,
    'physical_name', v_t.physical_name,
    'op', 'insert',
    'test', true,
    'row', jsonb_build_object('id', gen_random_uuid(), 'note', 'This is a test event')
  );

  perform public.emit_event(
    v_type,
    'table_row',
    null,
    v_t.owner_id,
    v_t.name || ' test event',
    v_data,
    case when v_t.visibility = 'workspace' then 'workspace' else 'private' end
  );

  return jsonb_build_object('event_type', v_type, 'data', v_data);
end;
$$;
revoke execute on function public.emit_test_table_event(uuid) from anon, public;
grant execute on function public.emit_test_table_event(uuid) to authenticated, service_role;
