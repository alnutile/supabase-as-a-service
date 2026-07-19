-- Control-plane schema (its OWN Supabase project — never applied to tenants or
-- to the main app's project). Slice 2 of docs/tasks/hosted-control-plane.md.
--
-- tenants: one row per customer workspace, the system of record for the
--   state machine: pending_payment → provisioning → active | past_due |
--   canceled → paused → deleted (+ failed, retryable).
-- provisioning_jobs: the queue provision-tick claims from (one-time claim +
--   lease, mirroring the main app's agent_jobs pattern).
-- cp_events: append-only audit log of everything that happens to a tenant.

create type tenant_status as enum (
  'pending_payment', 'provisioning', 'active', 'past_due', 'canceled',
  'paused', 'deleted', 'failed'
);

create table public.tenants (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,30}$'),
  name text not null,
  admin_email text not null,
  status tenant_status not null default 'pending_payment',
  -- infra handles (filled in as provisioning completes)
  project_ref text unique,
  railway_service_id text,
  openrouter_key_hash text,
  app_url text,
  -- billing
  stripe_customer_id text unique,
  stripe_subscription_id text unique,
  current_period_end timestamptz,
  -- lifecycle
  paused_at timestamptz,
  delete_after timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.provisioning_jobs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  status text not null default 'queued' check (status in ('queued','running','ok','error')),
  -- resumability: step records + accumulated state (secrets are NEVER stored
  -- here — the OpenRouter runtime key goes straight into tenant project
  -- secrets and is dropped from state before persisting)
  steps jsonb not null default '[]'::jsonb,
  state jsonb not null default '{}'::jsonb,
  error text,
  attempts int not null default 0,
  -- one-time claim + lease (agent_jobs pattern): a stale lease is reclaimable
  claimed_at timestamptz,
  lease_expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index provisioning_jobs_queue on public.provisioning_jobs (status, created_at);

create table public.cp_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references public.tenants (id) on delete set null,
  type text not null,          -- signup, payment.completed, provision.step, paused, …
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index cp_events_tenant on public.cp_events (tenant_id, created_at desc);

-- The control plane has no end-user accounts in v1 — the public surface is the
-- signup/status/stripe-webhook edge functions running as the service role, and
-- the internal admin UI is gated by control-plane operator accounts. Lock all
-- three tables down: no anon/authenticated access; service role bypasses RLS.
alter table public.tenants enable row level security;
alter table public.provisioning_jobs enable row level security;
alter table public.cp_events enable row level security;
