-- list_links now returns each bookmark's saved/last-updated timestamps and
-- takes a date range.
--
-- links.created_at / links.updated_at have existed since 0049 but were never
-- surfaced, so an agent (or an external Claude over MCP, which delegates to the
-- same builtin) could not answer "what did we save this week" without pulling
-- everything. The handler lives in `_shared/builtins.ts` with the pure
-- rendering + bound parsing in `_shared/links.ts`; this migration only refreshes
-- the tool row the model reads, so it knows the dates and the new
-- `since` / `until` / `date_field` inputs exist.
--
-- Idempotent: a plain UPDATE, safe to re-apply.

update public.tools
set description = 'List saved links, newest first (optionally filter by collection name/id and by a date range). Shows each link''s title, URL, description, id, and when it was saved and last updated.',
    input_schema = '{"type":"object","properties":{"collection":{"type":"string","description":"Optional collection name or id to filter by."},"since":{"type":"string","description":"Only links at/after this point — ISO 8601 timestamp or YYYY-MM-DD (from the start of that day)."},"until":{"type":"string","description":"Only links at/before this point — ISO 8601 timestamp or YYYY-MM-DD (through the end of that day)."},"date_field":{"type":"string","enum":["created","updated"],"description":"Which date the range filters on: when the link was saved (default) or last updated."}}}'::jsonb
where name = 'list_links'
  and is_builtin;
