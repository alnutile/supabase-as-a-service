-- Webhooks: an external system POSTs data to a per-webhook URL; the attached
-- prompt processes that payload via Claude and the result is logged. What we DO
-- with the result (create artifact, post to chat, call out, …) comes later — for
-- now we capture every event and its output.

create table public.webhooks (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  prompt text not null default '',
  token uuid not null default gen_random_uuid() unique, -- opaque, lives in the URL
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index webhooks_owner_idx on public.webhooks (owner_id);

alter table public.webhooks enable row level security;

create policy "Owners manage their webhooks"
  on public.webhooks for all
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

-- One row per inbound request.
create table public.webhook_events (
  id uuid primary key default gen_random_uuid(),
  webhook_id uuid not null references public.webhooks (id) on delete cascade,
  status text not null default 'received', -- received | ok | error
  payload jsonb,
  result text,
  error text,
  created_at timestamptz not null default now()
);
create index webhook_events_webhook_idx on public.webhook_events (webhook_id, created_at desc);

alter table public.webhook_events enable row level security;

-- Events are written by the edge function (service role, bypasses RLS).
-- Owners can only read events belonging to their own webhooks.
create policy "Owners read their webhook events"
  on public.webhook_events for select
  using (
    exists (select 1 from public.webhooks w where w.id = webhook_id and w.owner_id = auth.uid())
  );

-- Live updates in the Webhooks page as events arrive.
alter publication supabase_realtime add table public.webhook_events;
