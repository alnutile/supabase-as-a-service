-- Evals over MCP + collections as grounding + model-matrix compare.
--
-- Three small additions, no new tables — the eval schema (0025/0026) already
-- carries a `model` override per run (that's the matrix: one run per model) and a
-- free-form case shape, so the MCP surface and the model-compare need nothing new.
-- The one genuinely new capability is grounding a chat/agent suite in a
-- collection's content: when `collection_ids` is set, every case is answered with
-- that collection injected as primary context (the same loadCollectionsContext the
-- chat/agent/scheduler loops use), and the judge grades the answer against the
-- case's reference. Cases stay hand-authored; the collection is the knowledge set
-- the pipeline must answer FROM, so you can ask "does the assistant answer
-- correctly out of THIS collection".
--
-- RLS is unchanged (members read, admins write). The MCP server runs as the
-- service role and re-enforces admin in code, exactly like it does for skills.

alter table public.eval_suites
  add column if not exists collection_ids uuid[] not null default '{}'::uuid[];

comment on column public.eval_suites.collection_ids is
  'Optional collections injected as grounding context for chat/agent runs (loadCollectionsContext). Empty = no grounding.';
