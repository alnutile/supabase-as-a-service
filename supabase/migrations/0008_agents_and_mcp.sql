-- Agents + MCP access.
--
-- An *agent* is a first-class, deployable unit: a name + a system prompt +
-- the tools it may use. You build them in the dashboard, or from an external
-- Claude (Claude Code / Desktop) over the MCP server, which pushes them here.

create table public.agents (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  description text not null default '',
  instructions text not null default '',   -- the agent's system prompt
  tool_ids uuid[] not null default '{}',    -- tools the agent may call
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index agents_owner_idx on public.agents (owner_id);

alter table public.agents enable row level security;

-- Agents are a shared workspace catalogue: everyone signed in can see them;
-- the owner (or an admin) edits.
create policy "Members read agents"
  on public.agents for select
  using (auth.uid() is not null);

create policy "Owner creates agents"
  on public.agents for insert
  with check (owner_id = auth.uid());

create policy "Owner or admin updates agents"
  on public.agents for update
  using (owner_id = auth.uid() or exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin))
  with check (owner_id = auth.uid() or exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin));

create policy "Owner or admin deletes agents"
  on public.agents for delete
  using (owner_id = auth.uid() or exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin));

-- Log agent creation into the activity feed.
create or replace function public.log_agent()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.activity_log (type, summary, detail, actor_id)
  values ('agent.created', 'Agent created: ' || new.name,
          jsonb_build_object('agent_id', new.id), new.owner_id);
  return new;
end; $$;
revoke execute on function public.log_agent() from anon, authenticated, public;

create trigger trg_log_agent
  after insert on public.agents
  for each row execute function public.log_agent();

-- MCP connection tokens: paste one into Claude Code/Desktop to let an external
-- Claude build things on this workspace. Each token acts as its owner.
create table public.mcp_tokens (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  name text not null default 'Claude',
  token uuid not null default gen_random_uuid() unique,
  last_used_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.mcp_tokens enable row level security;

create policy "Owners manage their MCP tokens"
  on public.mcp_tokens for all
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());
