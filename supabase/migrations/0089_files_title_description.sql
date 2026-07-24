-- Add title and description fields to files for better search and organization.
--
-- These fields help users organize and search files more effectively:
--   * `title` — optional human-readable title (defaults to filename if not set)
--   * `description` — optional long-form description for context
--
-- Both are nullable so the existing upload flow is unaffected. The Files UI will
-- allow inline editing of these fields, and they can be indexed for search.

alter table public.files add column if not exists title text;
alter table public.files add column if not exists description text;

-- Create an index on title for faster search queries
create index if not exists files_title_idx on public.files using gin (to_tsvector('english', coalesce(title, '')));
create index if not exists files_description_idx on public.files using gin (to_tsvector('english', coalesce(description, '')));
