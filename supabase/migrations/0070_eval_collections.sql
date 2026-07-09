-- Evals: test a pipeline WITH collection context (and a pasted system prompt).
--
-- The chat/agent eval targets ran the orchestrator with always-on prompts (or an
-- agent's instructions) but no collection grounding — so they couldn't faithfully
-- reproduce a Slack reply or a collection-scoped chat, where the answer is built
-- from a collection's docs/files/to-dos/links. This adds two suite-level knobs:
--
--   * `collection_ids` — the collections whose context is injected into the run,
--     exactly like the chat/webhook/slack path's loadCollectionsContext. For an
--     `agent` suite these are merged with the agent's own bound collections.
--   * `system_prompt` — an optional system override to paste the exact prompt
--     under test (e.g. the Slack reply prompt). Blank keeps today's behavior
--     (always-on prompts for `chat`, the agent's instructions for `agent`).
--
-- No RLS change: the existing eval_suites policies (members read, admins write)
-- already cover the new columns.

alter table public.eval_suites
  add column collection_ids uuid[] not null default '{}',
  add column system_prompt text not null default '';
