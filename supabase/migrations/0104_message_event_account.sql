-- 0104_message_event_account.sql
-- Per-inbox event scoping. Until now `message.received` carried source /
-- from_address / subject, so a Listener could filter by SOURCE (email vs slack)
-- but not by which specific inbox the mail came from. IMAP-ingested rows (0102)
-- and the "Test message" button both stamp `raw.account_id` with the originating
-- `email_accounts` id; surface it in the event data so a Listener can match ONE
-- inbox — "when mail arrives in THIS inbox, do X" — the same way collection_id /
-- source already filter (see _shared/events.ts matchListener). No new event type
-- and no UUID in the event name: the inbox is a filter on the existing event,
-- consistent with the rest of the automation layer. A Listener that sets no
-- inbox still catches every message.
create or replace function public.emit_message_event()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public.emit_event('message.received', 'inbox_message', new.id, new.owner_id,
    coalesce(nullif(new.subject, ''), nullif(new.from_address, ''), 'New message'),
    jsonb_build_object(
      'source', new.source,
      'from_address', new.from_address,
      'subject', new.subject,
      'account_id', new.raw ->> 'account_id'
    ),
    new.visibility);
  return new;
end; $$;

notify pgrst, 'reload schema';
