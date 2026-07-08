-- Reliable artifact → collection filing.
--
-- The gap: after the assistant creates an artifact (create_artifact, or a chat
-- :::artifact auto-save) it had no way to retrieve the new row's id or resolve it
-- by title, and add_to_collection was id-only — so "file this into collection X"
-- got stuck. This migration closes that:
--   • list_artifacts (NEW builtin) — list artifacts newest-first WITH ids, so the
--     id is retrievable in the same turn (handler reads the primary, no lag).
--   • create_artifact — now also accepts a `collections` array (file into several
--     at once) and its response includes the id.
--   • add_to_collection — now accepts `artifact_title` (exact) as an alternative
--     to artifact_id, resolved server-side, so the assistant can file without ever
--     seeing an id.
-- Handlers live in supabase/functions/_shared/builtins.ts (and mirrored in the MCP
-- server). These rows just expose / re-describe the builtins; they run with the
-- service role and re-enforce owner/workspace access in code.

-- 1. list_artifacts — the retrieval gap-filler.
insert into public.tools (name, description, input_schema, kind, is_builtin, is_active, created_by)
select 'list_artifacts',
  'List artifacts you can access, most recent first, with their ids — so after create_artifact (or a chat :::artifact) you can retrieve the id and file it into a collection. Optionally filter by collection (name/id), title_contains, or type.',
  '{"type":"object","properties":{"collection":{"type":"string","description":"Optional collection name or id to filter by."},"title_contains":{"type":"string","description":"Optional case-insensitive substring of the title."},"type":{"type":"string","enum":["markdown","code","html","text"],"description":"Optional artifact type filter."},"limit":{"type":"number","description":"Max rows (default 20, max 100)."}}}'::jsonb,
  'builtin', true, true,
  (select id from public.profiles order by created_at asc limit 1)
where not exists (select 1 from public.tools where name = 'list_artifacts');

-- 2. create_artifact — add the `collections` array; note the returned id.
update public.tools
set description = 'Create a shareable artifact (a doc/code/HTML/text). Optionally file it into one or more collections (by name; created if missing) so the team can chat with it. Returns the new artifact''s id and link. Use this to save articles, summaries, or notes you fetched.',
    input_schema = '{"type":"object","properties":{"title":{"type":"string"},"content":{"type":"string"},"type":{"type":"string","enum":["markdown","code","html","text"]},"collection":{"type":"string","description":"Optional single collection name (or id) to file this artifact into; created if it does not exist."},"collections":{"type":"array","items":{"type":"string"},"description":"Optional collection names (or ids) to file this artifact into; each created if missing."}},"required":["title","content"]}'::jsonb
where name = 'create_artifact' and is_builtin = true;

-- 3. add_to_collection — accept artifact_title as an alternative to artifact_id.
update public.tools
set description = 'Add an existing artifact to a collection. Identify the artifact by artifact_id OR artifact_title (exact, resolved server-side — so you can file a freshly-created artifact without ever seeing its id); the collection by name or id, created if it does not exist.',
    input_schema = '{"type":"object","properties":{"collection":{"type":"string","description":"Collection name or id."},"artifact_id":{"type":"string","description":"The artifact id to add (or use artifact_title)."},"artifact_title":{"type":"string","description":"The exact artifact title to add (alternative to artifact_id)."}},"required":["collection"]}'::jsonb
where name = 'add_to_collection' and is_builtin = true;
