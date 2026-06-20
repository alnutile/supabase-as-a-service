-- Per-message feedback: the seed for output evaluation.
--
-- Every assistant reply can be rated by the user who owns the conversation
-- (thumbs up/down + an optional category + a free-text note). This is both an
-- immediate quality signal and the labeled training/eval data the roadmap's
-- "output evaluation" builds on, so the workspace learns what "good" looks like
-- for the business over time.
--
-- The `context` snapshot captures *what produced the answer* at feedback time
-- (model slug, agent, active skill, tool names) so feedback can later be
-- attributed — "answers from this skill score well", "this model drifts" —
-- instead of being a bare like count. The chat UI writes it on the client; an
-- evaluation job (service role) reads across the workspace.
--
-- RLS mirrors usage_events / activity_log: a member manages their own rows, an
-- admin can read all (for workspace-wide evaluation).

create table public.message_feedback (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null references public.messages (id) on delete cascade,
  conversation_id uuid references public.conversations (id) on delete set null,
  owner_id uuid not null references auth.users (id) on delete cascade,
  rating text not null check (rating in ('up', 'down')),
  -- optional structured reason chip; free-form so the UI can iterate without a
  -- migration. Suggested values: 'off_target' | 'needs_work' | 'exactly_right'.
  category text,
  note text,
  -- snapshot of what produced the rated answer (model, agent_id, skill, tools).
  agent_id uuid references public.agents (id) on delete set null,
  context jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- one verdict per user per message; the client upserts on (message_id, owner_id).
  unique (message_id, owner_id)
);

create index message_feedback_message_idx on public.message_feedback (message_id);
create index message_feedback_created_idx on public.message_feedback (created_at desc);
create index message_feedback_agent_idx on public.message_feedback (agent_id, created_at desc);

alter table public.message_feedback enable row level security;

-- Owner has full control over their own feedback (read/write/change/delete).
create policy "Owners manage their feedback"
  on public.message_feedback for all
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

-- Admins can read all feedback for workspace-wide evaluation (read-only).
create policy "Admins read all feedback"
  on public.message_feedback for select
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin));
