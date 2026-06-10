-- Activity log + chat file attachments.

-- 1) A unified activity feed. Rows are written by triggers (webhook events,
--    artifacts, files) and by the chat edge function (tool calls). Readable by
--    the actor, or by any admin (the ops view).
create table public.activity_log (
  id uuid primary key default gen_random_uuid(),
  type text not null,                 -- e.g. webhook.received, tool.call, artifact.created
  summary text not null,
  detail jsonb,
  actor_id uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);
create index activity_log_created_idx on public.activity_log (created_at desc);

alter table public.activity_log enable row level security;

create policy "Read own or admin all activity"
  on public.activity_log for select
  using (
    actor_id = auth.uid()
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin)
  );
-- No insert/update/delete policy: only triggers (definer) and the service role write.

alter publication supabase_realtime add table public.activity_log;

-- 2) Triggers that feed the log from existing tables.
create or replace function public.log_webhook_event()
returns trigger language plpgsql security definer set search_path = public as $$
declare wname text; owner uuid;
begin
  select name, owner_id into wname, owner from public.webhooks where id = new.webhook_id;
  if tg_op = 'INSERT' then
    insert into public.activity_log (type, summary, detail, actor_id)
    values ('webhook.received', coalesce(wname, 'Webhook') || ' received an event',
            jsonb_build_object('webhook_id', new.webhook_id, 'event_id', new.id), owner);
  elsif tg_op = 'UPDATE' and new.status is distinct from old.status and new.status in ('ok', 'error') then
    insert into public.activity_log (type, summary, detail, actor_id)
    values ('webhook.' || new.status, coalesce(wname, 'Webhook') || ' run ' || new.status,
            jsonb_build_object('webhook_id', new.webhook_id, 'event_id', new.id, 'error', new.error), owner);
  end if;
  return new;
end; $$;

create trigger trg_log_webhook_event
  after insert or update on public.webhook_events
  for each row execute function public.log_webhook_event();

create or replace function public.log_artifact()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.activity_log (type, summary, detail, actor_id)
  values ('artifact.created', 'Artifact created: ' || new.title,
          jsonb_build_object('artifact_id', new.id, 'type', new.type), new.owner_id);
  return new;
end; $$;

create trigger trg_log_artifact
  after insert on public.artifacts
  for each row execute function public.log_artifact();

create or replace function public.log_file()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.activity_log (type, summary, detail, actor_id)
  values ('file.uploaded', 'File uploaded: ' || new.name,
          jsonb_build_object('file_id', new.id, 'size_bytes', new.size_bytes), new.owner_id);
  return new;
end; $$;

create trigger trg_log_file
  after insert on public.files
  for each row execute function public.log_file();

-- Trigger functions still fire as triggers after EXECUTE is revoked; this stops
-- them being callable directly via the REST RPC endpoint.
revoke execute on function public.log_webhook_event() from anon, authenticated, public;
revoke execute on function public.log_artifact() from anon, authenticated, public;
revoke execute on function public.log_file() from anon, authenticated, public;

-- 3) Chat file attachments: files attached to a user message so the assistant
--    can read them. Each entry is { path, name, mime }.
alter table public.messages add column if not exists attachments jsonb;
