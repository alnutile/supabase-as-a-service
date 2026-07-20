-- Tools: capabilities the assistant can call during chat. Tools-as-data — each
-- row becomes a real callable tool the chat edge function exposes to Claude.
--   • kind = 'http'  → custom tool. Claude calls it with JSON inputs; the edge
--     function POSTs those inputs to config.url and returns the response.
--   • kind = 'web'   → built-in. Switches on Anthropic's server-side web search
--     + fetch so the assistant can read URLs / search the web itself.
-- Tools are workspace-wide and powerful (an http tool calls arbitrary URLs from
-- the server), so only admins manage them; everyone can see what's enabled.

create table public.tools (
  id uuid primary key default gen_random_uuid(),
  name text not null,                       -- function name exposed to Claude (snake_case)
  description text not null default '',     -- when/how Claude should use it
  input_schema jsonb not null default '{"type":"object","properties":{}}'::jsonb,
  kind text not null default 'http',        -- http | web
  config jsonb not null default '{}'::jsonb, -- http: { url, method, headers }
  is_active boolean not null default true,
  is_builtin boolean not null default false,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.tools enable row level security;

-- Everyone signed in can see the enabled toolset; only admins can change it.
create policy "Members read tools"
  on public.tools for select
  using (auth.uid() is not null);

create policy "Admins insert tools"
  on public.tools for insert
  with check (exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin));

create policy "Admins update tools"
  on public.tools for update
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin))
  with check (exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin));

create policy "Admins delete tools"
  on public.tools for delete
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin));

-- Ship with web browsing on so the assistant can read URLs out of the gate.
insert into public.tools (name, description, kind, is_builtin, is_active, created_by)
select 'web_browsing',
  'Search the web and fetch the contents of URLs. Use when the user asks about a website, a current fact, or anything you need to look up or read online.',
  'web', true, true,
  (select id from public.profiles order by created_at asc limit 1);

-- Teach the assistant that it has tools and how to help define new ones.
update public.skills
set instructions = instructions || E'\n\nTOOLS\nYou may have tools available (e.g. web browsing, plus custom tools an admin added) — use them whenever they help answer or act. If the user wants a capability you don''t have, help them define a new tool: propose a snake_case name, a one-line description of when to use it, a JSON Schema for its inputs, and the HTTP endpoint it should POST to. Tell them an admin can add it on the Tools page.'
where is_builtin = true;
