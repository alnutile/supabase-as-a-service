-- Correct where a PERSON's to-dos land: `next`, not `triage`.
--
-- (Renumbered from a colliding 0117 that clashed with main's
-- 0117_dropbox_provider_check, which landed while this was being written. The
-- migrations.test.ts unique-prefix guard caught it — a duplicate prefix aborts
-- `supabase db push` for the whole fleet.)
--
-- 0116 gave every existing row the column default, `triage` — "new, not looked
-- at yet". For a fresh workspace that's right. For a real one it was wrong: a
-- backlog someone had already written down and committed to is not unreviewed,
-- and dumping all of it into one lane makes the Board a single tall column and
-- the Focus queue a wall of work that reads as agent-filed. It also contradicts
-- 0116's own rule — un-ticking a to-do lands in `next` precisely BECAUSE it was
-- already committed to. A backfill of an open list is that same case.
--
-- `triage` keeps its meaning for what it was designed for: work filed AT you by
-- an agent, the REST API, or the inbox. That is why this is scoped to
-- `source is null` (a person added it) rather than moving everything.

update public.todos
set status = 'next'
where status = 'triage'
  and not done
  -- A person added it. Anything an agent or the API filed stays in triage:
  -- unreviewed by design, and the Focus queue leads with it on purpose.
  and source is null
  -- Only rows that predate 0116 and so were assigned the lane by its default,
  -- never by a real choice. Without this bound the update would also sweep up a
  -- to-do genuinely triaged since. 0116 applied at 2026-08-29T03:00:47Z.
  and created_at < timestamptz '2026-08-29T03:00:47Z';
