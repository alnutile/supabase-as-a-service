-- A webhook can target an agent: instead of running a bare prompt on the
-- payload, it runs the agent (its instructions + its tools) over the payload.
alter table public.webhooks
  add column if not exists agent_id uuid references public.agents (id) on delete set null;
