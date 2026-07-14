-- Features board: the self-improvement pipeline as a kanban.
--
-- A `features` row is a feature request / bug report (title, description,
-- optional screenshots living in the private `files` bucket). Lanes:
--   idea      → anyone on the team files it
--   approved  → an ADMIN dragged it here: the `features` edge function opens a
--               GitHub issue labeled `approved-for-work`; the Claude Code
--               GitHub Action picks it up, implements it on a branch, and opens
--               a PR that references the issue. The PR is tracked on the card.
--   ready     → an ADMIN dragged it here: the edge function merges the PR
--               (squash). Merge = deploy (Railway auto-deploys main; the
--               supabase-deploy workflow pushes migrations/functions).
--   shipped   → the PR merged.
--
-- The two human approvals are lane moves: idea→approved (spend AI effort) and
-- ready-merge (ship code). The AI never touches main directly — the PR review
-- is the security boundary between "attacker-reachable feature text" and
-- "code running in production".

create table public.features (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  description text not null default '',
  screenshots jsonb not null default '[]'::jsonb,  -- storage paths in the files bucket
  lane text not null default 'idea' check (lane in ('idea', 'approved', 'ready', 'shipped')),
  position integer not null default 0,
  issue_number integer,          -- GitHub issue opened on approval
  pr_number integer,             -- PR the action opened (synced)
  pr_url text,
  pr_state text,                 -- open | merged | closed (synced)
  last_error text,               -- last approve/merge/sync failure, shown on the card
  owner_id uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.features enable row level security;

-- The board is workspace-visible; anyone can file an idea. Lane moves and
-- edits are admin-only EXCEPT the owner may edit/delete their own card while
-- it is still an idea (before any GitHub side effects exist).
create policy "Members read features"
  on public.features for select
  using (auth.uid() is not null);

create policy "Members file ideas"
  on public.features for insert
  with check (owner_id = auth.uid() and lane = 'idea');

create policy "Admins update features"
  on public.features for update
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin))
  with check (exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin));

create policy "Owners edit their ideas"
  on public.features for update
  using (owner_id = auth.uid() and lane = 'idea')
  with check (owner_id = auth.uid() and lane = 'idea');

create policy "Admins delete features"
  on public.features for delete
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin));

create policy "Owners delete their ideas"
  on public.features for delete
  using (owner_id = auth.uid() and lane = 'idea');
