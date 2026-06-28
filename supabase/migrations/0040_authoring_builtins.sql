-- Content-authoring builtins for the INTERNAL assistant — parity with the MCP
-- server's authoring actions, so the in-app AI and agents (chat, scheduler,
-- webhook) can push content into artifacts + collections + the knowledge base.
-- This is what lets "the chat AI pulls a bunch of GitHub articles and files them
-- into a collection we can chat with" work without an external Claude.
--
-- The handlers live in supabase/functions/_shared/builtins.ts (runBuiltin); these
-- rows just expose them as `is_builtin` tools. They run with the service role and
-- re-enforce access in code (owner = caller; collections resolve to own/workspace).
-- Seeded active and not-deletable (RLS mirrors other builtins). Admins can toggle
-- any of them off on the Tools page.

insert into public.tools (name, description, input_schema, kind, is_builtin, is_active, created_by)
select 'create_artifact',
  'Create a shareable artifact (a doc/code/HTML/text). Optionally file it into a collection (by name; created if missing) so the team can chat with it. Use this to save articles, summaries, or notes you fetched.',
  '{"type":"object","properties":{"title":{"type":"string"},"content":{"type":"string"},"type":{"type":"string","enum":["markdown","code","html","text"]},"collection":{"type":"string","description":"Optional collection name (or id) to file this artifact into; created if it does not exist."}},"required":["title","content"]}'::jsonb,
  'builtin', true, true,
  (select id from public.profiles order by created_at asc limit 1)
where not exists (select 1 from public.tools where name = 'create_artifact');

insert into public.tools (name, description, input_schema, kind, is_builtin, is_active, created_by)
select 'list_collections',
  'List the collections (named groups of artifacts) you can access.',
  '{"type":"object","properties":{}}'::jsonb,
  'builtin', true, true,
  (select id from public.profiles order by created_at asc limit 1)
where not exists (select 1 from public.tools where name = 'list_collections');

insert into public.tools (name, description, input_schema, kind, is_builtin, is_active, created_by)
select 'create_collection',
  'Create a collection: a named group of artifacts the user can chat with as a focused context. Use this to centralize content (articles, posts, notes) under one name.',
  '{"type":"object","properties":{"name":{"type":"string"},"description":{"type":"string"},"shared":{"type":"boolean","description":"Share with the whole workspace (default private to you)."}},"required":["name"]}'::jsonb,
  'builtin', true, true,
  (select id from public.profiles order by created_at asc limit 1)
where not exists (select 1 from public.tools where name = 'create_collection');

insert into public.tools (name, description, input_schema, kind, is_builtin, is_active, created_by)
select 'add_to_collection',
  'Add an existing artifact to a collection (both by name or id). The collection is created if it does not exist.',
  '{"type":"object","properties":{"collection":{"type":"string","description":"Collection name or id."},"artifact_id":{"type":"string","description":"The artifact id to add."}},"required":["collection","artifact_id"]}'::jsonb,
  'builtin', true, true,
  (select id from public.profiles order by created_at asc limit 1)
where not exists (select 1 from public.tools where name = 'add_to_collection');

insert into public.tools (name, description, input_schema, kind, is_builtin, is_active, created_by)
select 'add_note',
  'Add a text note — an article, transcript, doc, any plain text — to the workspace knowledge base. It is chunked, embedded, and made searchable via search_documents. For a shareable document use create_artifact instead.',
  '{"type":"object","properties":{"title":{"type":"string","description":"A short title."},"content":{"type":"string","description":"The full text to index."},"scope":{"type":"string","enum":["workspace","private"],"description":"workspace (default) = searchable by the whole team; private = only you."}},"required":["title","content"]}'::jsonb,
  'builtin', true, true,
  (select id from public.profiles order by created_at asc limit 1)
where not exists (select 1 from public.tools where name = 'add_note');
