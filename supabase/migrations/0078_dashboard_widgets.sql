-- Dashboard widgets — user-composable tiles on the Home "what's going on"
-- overview. DB-driven, not code: a `dashboard_widgets` row is
-- `{ kind, source, spec }` and the app renders it, so a customer can add their
-- own widgets without forking/redeploying (same configuration-as-data model as
-- tools/agents/forge). The AI creates them from a natural-language prompt via
-- the seeded `create_widget` builtin; the dashboard executes each widget's
-- query with the ordinary (RLS-scoped) client, so **RLS is the security
-- boundary** — a stored spec can never read another user's rows.
--
--   * kind   — the renderer: 'stat' (a count), 'list' (recent rows), 'chart'
--              (per-day bars).
--   * source — a table from a fixed allow-list, mirrored in src/lib/widgets.ts
--              and _shared/widgets.ts: todos | artifacts | files | links |
--              collections | activity.
--   * spec   — a small declarative jsonb: { window, mine, status, limit }.
--
-- Owner-only (like conversations / user_memories): the dashboard is personal,
-- so a widget never leaks across users. Joins realtime so a widget the AI adds
-- in chat pops onto the dashboard live. Seeds create_widget / list_widgets /
-- remove_widget so chat + agents + the MCP server can manage them.

create table public.dashboard_widgets (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  title text not null default 'Widget',
  kind text not null check (kind in ('stat', 'list', 'chart')),
  source text not null check (
    source in ('todos', 'artifacts', 'files', 'links', 'collections', 'activity')
  ),
  spec jsonb not null default '{}'::jsonb,
  position integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index dashboard_widgets_owner_idx
  on public.dashboard_widgets (owner_id, position asc, created_at asc);

alter table public.dashboard_widgets enable row level security;
grant select, insert, update, delete on public.dashboard_widgets to authenticated;

-- Owner-only at every verb (personal dashboard; deliberately NOT the
-- private/workspace model — one user's widgets never appear on another's).
create policy "Read own widgets"
  on public.dashboard_widgets for select
  using (owner_id = auth.uid());

create policy "Insert own widgets"
  on public.dashboard_widgets for insert
  with check (owner_id = auth.uid());

create policy "Update own widgets"
  on public.dashboard_widgets for update
  using (owner_id = auth.uid());

create policy "Delete own widgets"
  on public.dashboard_widgets for delete
  using (owner_id = auth.uid());

create trigger dashboard_widgets_set_updated_at
  before update on public.dashboard_widgets
  for each row execute function public.set_updated_at();

-- Live: a widget the assistant adds in chat appears on the dashboard at once.
alter publication supabase_realtime add table public.dashboard_widgets;

-- ---------------------------------------------------------------------------
-- Seed the builtin tools (idempotent via `where not exists`; created_by = the
-- first/admin profile, same convention as the other builtin seeds).
-- ---------------------------------------------------------------------------
insert into public.tools (name, description, input_schema, kind, is_builtin, is_active, created_by)
select 'create_widget',
  'Add a widget to the user''s Home dashboard from a description. Pick a `kind`: "stat" (a single count), "list" (recent rows), or "chart" (per-day bar chart). Pick a `source` (the data): todos | artifacts | files | links | collections | activity. Optional `spec`: {"window": today|7d|30d|all, "mine": true, "status": open|done (todos only), "limit": 1-20 (list only)}. Give it a short `title`. Example: to show "my artifacts added today" use kind:"list", source:"artifacts", spec:{"mine":true,"window":"today"}.',
  '{"type":"object","properties":{"title":{"type":"string","description":"Short widget title shown on the card."},"kind":{"type":"string","enum":["stat","list","chart"],"description":"The renderer."},"source":{"type":"string","enum":["todos","artifacts","files","links","collections","activity"],"description":"Which data the widget shows."},"spec":{"type":"object","description":"Optional filters.","properties":{"window":{"type":"string","enum":["today","7d","30d","all"]},"mine":{"type":"boolean"},"status":{"type":"string","enum":["open","done"]},"limit":{"type":"number"}}}},"required":["title","kind","source"]}'::jsonb,
  'builtin', true, true,
  (select id from public.profiles order by created_at asc limit 1)
where not exists (select 1 from public.tools where name = 'create_widget');

insert into public.tools (name, description, input_schema, kind, is_builtin, is_active, created_by)
select 'list_widgets',
  'List the widgets on the user''s Home dashboard (with ids), so you can reference or remove one.',
  '{"type":"object","properties":{}}'::jsonb,
  'builtin', true, true,
  (select id from public.profiles order by created_at asc limit 1)
where not exists (select 1 from public.tools where name = 'list_widgets');

insert into public.tools (name, description, input_schema, kind, is_builtin, is_active, created_by)
select 'remove_widget',
  'Remove a widget from the user''s Home dashboard by its id (get ids from list_widgets).',
  '{"type":"object","properties":{"id":{"type":"string","description":"The widget id to remove."}},"required":["id"]}'::jsonb,
  'builtin', true, true,
  (select id from public.profiles order by created_at asc limit 1)
where not exists (select 1 from public.tools where name = 'remove_widget');
