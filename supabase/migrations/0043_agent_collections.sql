-- Bind collections to an agent, the same shape as its `tool_ids`. When the agent
-- runs (chat, webhook, or scheduler), the content of its bound collections —
-- artifacts, files, to-dos — is injected as primary context, so the agent can
-- "use" a focused knowledge set in its automation. (Adding *into* collections is
-- already covered by the is_builtin authoring tools create_collection /
-- add_to_collection / create_artifact / add_todo_to_collection, scoped via tool_ids.)
alter table public.agents
  add column collection_ids uuid[] not null default '{}';
