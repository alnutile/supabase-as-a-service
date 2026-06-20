-- Forged functions: the "vibe-code an edge function" registry. Each row is a
-- Supabase Edge Function that was generated/written from inside the app and
-- deployed to the live project via the Management API (supabase/functions/forge).
-- It is the system-of-record + audit trail for that code: the spec it was built
-- from, the exact generated source (for redeploy), the deploy status, and a link
-- to the `tools` row that exposes it to the agent loops.
--
-- The deployed function itself runs with verify_jwt=false (the chat/webhook/
-- scheduler loops call it server-to-server like any custom http tool) and is
-- gated by `invoke_token` carried in the request — same posture as `webhook` /
-- `email-inbound`. Forging is powerful (it deploys running code), so writes are
-- admin-only; RLS mirrors `tools` exactly (members read, admins write).

create table public.forged_functions (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,                  -- the Supabase function slug (URL path segment)
  name text not null,                         -- human title
  spec text not null default '',              -- the natural-language request it was built from (audit)
  source text not null,                       -- the deployed index.ts (audit + redeploy source of truth)
  model text,                                 -- model id used to generate it (null if hand-written)
  input_schema jsonb not null default '{"type":"object","properties":{}}'::jsonb,
  status text not null default 'draft',       -- draft | deployed | failed | disabled
  deploy_error text,                          -- last deploy/bundle error, if any
  invoke_token text not null default encode(gen_random_bytes(24), 'hex'), -- per-function request secret
  tool_id uuid references public.tools (id) on delete set null,           -- the tools row that exposes it
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Slug must be a safe function name and must not collide with the platform's
  -- own functions. The forge function enforces the same rules in code.
  constraint forged_functions_slug_format check (slug ~ '^[a-z][a-z0-9_-]{2,40}$'),
  constraint forged_functions_slug_reserved check (
    slug not in ('chat', 'webhook', 'mcp', 'scheduler', 'ingest', 'email-inbound', 'email-test', 'forge')
  )
);

alter table public.forged_functions enable row level security;

-- Everyone signed in can see what's been forged; only admins can change it.
create policy "Members read forged functions"
  on public.forged_functions for select
  using (auth.uid() is not null);

create policy "Admins insert forged functions"
  on public.forged_functions for insert
  with check (exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin));

create policy "Admins update forged functions"
  on public.forged_functions for update
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin))
  with check (exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin));

create policy "Admins delete forged functions"
  on public.forged_functions for delete
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin));
