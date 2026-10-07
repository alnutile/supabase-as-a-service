-- 0129_artifact_public_urls.sql
--
-- Public artifact links over the tool surface. The app's public share route is
-- /share/a/:slug and resolves by artifacts.public_slug — NOT the id — but the
-- artifact tools only ever returned the signed-in editor path /artifacts/<id>,
-- so an agent building a page of public links wrote /share/a/<id> and 404'd.
-- The tools now return visibility, public_slug, public_url (null unless the
-- artifact is unlisted/public) and standalone_url (html only), built from the
-- APP_URL edge secret (_shared/artifacts.ts artifactUrls, unit-tested).
--
-- Schema-less: this only re-describes get_artifact / list_artifacts and seeds
-- the new share_artifact builtin (owner-only: sets unlisted/public and mints a
-- public_slug when missing, same rule as the editor's Sharing panel).

update public.tools
set description = 'Read one artifact by its id or exact title: returns the id, title, type, url (the signed-in editor), visibility, public_slug, public_url, standalone_url (html only), collections, current content, and saved interactive state (data). Use this before update_artifact so you edit the latest version instead of guessing. To link to an artifact publicly, use public_url. Never build share links from the id. If public_url is null the artifact is not shared.'
where name = 'get_artifact' and is_builtin = true;

update public.tools
set description = 'List artifacts you can access, most recent first, with their ids, url, visibility and public_url (+ standalone_url for html). Optionally filter by collection (name/id), title_contains, type, or archived (the recovery area). To link to an artifact publicly, use public_url. Never build share links from the id. If public_url is null the artifact is not shared.'
where name = 'list_artifacts' and is_builtin = true;

insert into public.tools (name, description, input_schema, kind, is_builtin, is_active, created_by)
select 'share_artifact',
  'Publish an artifact you own by link (by id or exact title): sets its visibility to "unlisted" (default — anyone with the link) or "public", creates its public slug if missing, and returns public_url (and standalone_url for html). Owner only. To link to an artifact publicly, use public_url. Never build share links from the id. If public_url is null the artifact is not shared.',
  '{"type":"object","properties":{"artifact":{"type":"string","description":"The artifact id or its exact title."},"visibility":{"type":"string","enum":["unlisted","public"],"description":"Default \"unlisted\"."}},"required":["artifact"]}'::jsonb,
  'builtin', true, true,
  (select id from public.profiles order by created_at asc limit 1)
where not exists (select 1 from public.tools where name = 'share_artifact');
