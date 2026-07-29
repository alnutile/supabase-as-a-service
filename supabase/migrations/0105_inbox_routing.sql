-- 0105_inbox_routing.sql
-- "When mail arrives here → do X" for inboxes, mirroring the webhook pattern
-- (a webhook can go straight into a table.column / an agent / a function). The
-- Inbox is the same ingest→route shape, except the message ALSO persists in the
-- Inbox. We reuse the existing automation spine rather than add a parallel one:
-- the inbox editor manages ONE per-inbox event_listener (scoped to the account's
-- id via the 0104 account_id match), so routing runs through the same tested
-- event-dispatch path as every other listener — a deterministic run_tool
-- (add_table_row) needs no model, exactly like the webhook's direct-tool mode.
--
-- Two additions here:
--   1. message.received now also carries `body` (a preview) and `received_at`, so
--      a "Save to table" mapping can fill a Body / Received column deterministically
--      (the event previously had only source/from/subject/account_id).
--   2. email_accounts.routing_listener_id links the inbox to the listener the
--      editor manages, so opening the inbox re-populates the routing UI and a
--      re-save updates that same rule (on delete of the listener → set null).

-- 1. Richer message event (add body preview + received_at; keep everything else).
create or replace function public.emit_message_event()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public.emit_event('message.received', 'inbox_message', new.id, new.owner_id,
    coalesce(nullif(new.subject, ''), nullif(new.from_address, ''), 'New message'),
    jsonb_build_object(
      'source', new.source,
      'from_address', new.from_address,
      'subject', new.subject,
      'account_id', new.raw ->> 'account_id',
      'received_at', new.received_at,
      'body', left(coalesce(new.body_text, ''), 8000)
    ),
    new.visibility);
  return new;
end; $$;

-- 2. Link an inbox to its managed routing listener.
alter table public.email_accounts
  add column if not exists routing_listener_id uuid references public.event_listeners (id) on delete set null;

-- Owner/admin setter for the link (no client UPDATE policy exists on the table;
-- the editor creates/updates the listener row itself under RLS, then points the
-- account at it — or passes null to detach).
create or replace function public.set_email_account_routing(p_account_id uuid, p_listener_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner uuid;
  v_is_admin boolean;
begin
  select owner_id into v_owner from public.email_accounts where id = p_account_id;
  if v_owner is null then
    raise exception 'Inbox not found';
  end if;
  select p.is_admin into v_is_admin from public.profiles p where p.id = auth.uid();
  if v_owner <> auth.uid() and not coalesce(v_is_admin, false) then
    raise exception 'Not allowed to edit this inbox';
  end if;
  update public.email_accounts
    set routing_listener_id = p_listener_id, updated_at = now()
    where id = p_account_id;
end;
$$;
revoke execute on function public.set_email_account_routing(uuid, uuid) from anon, public;
grant execute on function public.set_email_account_routing(uuid, uuid) to authenticated;

-- Deleting an inbox now also removes its managed routing listener (so no dangling
-- rule lingers on the Listeners page). Otherwise unchanged from 0102.
create or replace function public.delete_email_account(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  v_secret_id uuid;
  v_owner uuid;
  v_listener uuid;
  v_is_admin boolean;
begin
  select secret_id, owner_id, routing_listener_id into v_secret_id, v_owner, v_listener
    from public.email_accounts where id = p_id;
  if v_secret_id is null then
    return;
  end if;
  select p.is_admin into v_is_admin from public.profiles p where p.id = auth.uid();
  if v_owner <> auth.uid() and not coalesce(v_is_admin, false) then
    raise exception 'Not allowed to delete this inbox';
  end if;
  delete from public.email_accounts where id = p_id;
  delete from vault.secrets where id = v_secret_id;
  if v_listener is not null then
    delete from public.event_listeners where id = v_listener;
  end if;
end;
$$;

notify pgrst, 'reload schema';
