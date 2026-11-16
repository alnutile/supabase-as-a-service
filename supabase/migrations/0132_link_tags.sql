-- Link tags — add tagging support to the Links area (saved bookmarks).
--
-- Follows the same pattern as `files.tags` (0055) and `knowledge_pages.labels`
-- (0112): a `text[]` column with a GIN index for efficient filtering. Tags are
-- simple labels (e.g. "article", "reference", "important") that let users
-- organize and filter links beyond the collection system.
--
-- Tags are additive labels on a single link; collections are groupings that
-- links are filed into. Both can coexist — a link can be in one or more
-- collections AND carry tags like "article" or "urgent".
--
-- Design rationale:
-- * `text[]` with GIN index — follows the established pattern for files/labels;
--   simpler than a normalized `tags` + `link_tags` join table for this use case.
-- * RLS unchanged — tags are part of the link row, so existing owner/visibility
--   policies already secure them.
-- * Nullable — existing links have no tags; the column is purely additive.
-- * SQL-friendly — setting tags from SQL is `UPDATE links SET tags = ARRAY['article']
--   WHERE id = ...` or `tags = '{article,reference}'::text[]`, so an automated
--   bot writing directly via Supabase SQL can tag links without app code.

-- Add the tags column to links (nullable, default empty).
alter table public.links add column if not exists tags text[] default '{}';

-- GIN index for efficient tag filtering: WHERE tags @> ARRAY['article'] finds
-- every link tagged "article" without a table scan. The operator @> (contains)
-- checks if the left array contains all elements of the right array.
create index if not exists links_tags_idx on public.links using gin (tags);

-- ---------------------------------------------------------------------------
-- Update the builtin tools to support tags. Idempotent via `where name = ...`.
-- ---------------------------------------------------------------------------

-- save_link: add tags to the input schema (optional array of strings).
update public.tools
set input_schema = '{"type":"object","properties":{"url":{"type":"string","description":"The full http(s) URL to save."},"title":{"type":"string","description":"Optional title override (otherwise fetched from the page)."},"notes":{"type":"string","description":"Optional notes about why this link matters."},"tags":{"type":"array","items":{"type":"string"},"description":"Optional tags (e.g. [\"article\", \"reference\"])."},"collection":{"type":"string","description":"Optional collection name (or id) to file this link into; created if missing."}},"required":["url"]}'::jsonb
where name = 'save_link';

-- list_links: add tag filtering to the input schema and mention tags in the
-- description so the model knows they are returned.
update public.tools
set 
  description = 'List saved links (optionally filter by collection, tag, or both). Shows each link''s title, URL, description and tags.',
  input_schema = '{"type":"object","properties":{"collection":{"type":"string","description":"Optional collection name or id to filter by."},"tag":{"type":"string","description":"Optional tag to filter by (shows only links with that tag)."}}}'::jsonb
where name = 'list_links';
