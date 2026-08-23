-- Archived compiled pages are a soft DELETE, so stop listing them by default.
--
-- 0112 shipped `list_knowledge_pages` without an archived filter, so a page
-- someone archived stayed fully visible to every agent through the listing and
-- through get_knowledge_page. That is inconsistent with how soft delete works
-- everywhere else in this workspace (artifacts and skills since 0101: hidden
-- from normal views, reachable only in the recovery area) — and it matters more
-- here than there, because the entire premise of the compiled layer is that a
-- compiled page carries MORE authority than a raw file. A page archived
-- *because it was wrong* must not keep being served as maintained knowledge.
--
-- The behaviour now matches list_artifacts: archived excluded by default,
-- `archived: true` for the recovery area. An explicit `status` filter still
-- wins, so status:'archived' keeps working. Enforced in code
-- (_shared/compiler_tools.ts, with the pure archiveScope() in _shared/compiler.ts);
-- this migration only updates the tool descriptions so the model knows the flag
-- exists and knows the default.

update public.tools
set description =
  'List the workspace''s COMPILED knowledge pages (maintained understanding) with ids and status. Check here BEFORE searching raw documents — a compiled page is the maintained answer; raw files are the evidence behind it. Archived pages are EXCLUDED by default; pass archived:true for the recovery area. Filter by collection, kind, status, or a title substring.',
    input_schema =
  '{"type":"object","properties":{"collection":{"type":"string","description":"Optional collection name or id."},"kind":{"type":"string","description":"Optional page kind: concept|decision|process|person|project|terminology|principle|question|profile."},"status":{"type":"string","description":"Optional status: compiled|needs-review|contradicted|stale|confirmed|archived."},"archived":{"type":"boolean","description":"true = list only ARCHIVED pages (the recovery area). Default false = only live pages."},"title_contains":{"type":"string","description":"Optional case-insensitive title substring."},"limit":{"type":"number","description":"Max rows (default 50, max 200)."}}}'::jsonb
where name = 'list_knowledge_pages';

update public.tools
set description =
  'Read one compiled knowledge page in full, with the claims behind it and where each claim came from. Identify it by id, by key, or by exact title. A page that is archived, contradicted, awaiting review or stale says so at the top — do not answer from it as if it were settled.'
where name = 'get_knowledge_page';
