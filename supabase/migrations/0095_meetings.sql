-- Meetings: live-chat + event support for the Meeting Notes recorder (Granola-style).
--
-- 1) conversations.meeting_id correlates a live chat thread with a meeting. A
--    meeting isn't its own table yet (it becomes an artifact on save), so this is
--    a client-generated uuid stamped at recording start; the saved artifact carries
--    the same id in its `data`, linking the thread to the finished notes. Owner-only
--    RLS on `conversations` already covers this column (each member gets their own
--    thread about their meeting), mirroring conversations.card_board_id (0076).
--
-- 2) A meeting emits a dedicated `meeting.recorded` event on save (in addition to
--    the generic artifact.created), so event_listeners can target MEETINGS
--    specifically — "when a meeting is recorded, run this agent" — instead of
--    reacting to every artifact.

alter table public.conversations
  add column if not exists meeting_id uuid;

create index if not exists conversations_meeting_idx
  on public.conversations (owner_id, meeting_id) where meeting_id is not null;

-- meeting.recorded — fires when a meeting-notes artifact is inserted. SECURITY
-- DEFINER + pinned search_path, mirroring the other emit_*_event() triggers (0063).
create or replace function public.emit_meeting_event()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if coalesce(new.data->>'meeting_notes', '') = 'true' then
    perform public.emit_event(
      'meeting.recorded',
      'artifact', new.id, new.owner_id,
      'Meeting recorded: ' || new.title,
      jsonb_build_object(
        'title', new.title,
        'meeting_id', new.data->>'meeting_id',
        'duration', new.data->>'duration'
      ),
      case when new.visibility = 'private' then 'private' else 'workspace' end
    );
  end if;
  return new;
end; $$;

drop trigger if exists trg_emit_meeting on public.artifacts;
create trigger trg_emit_meeting
  after insert on public.artifacts
  for each row execute function public.emit_meeting_event();
