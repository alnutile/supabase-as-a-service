-- Remove the Plugins feature (issue #103). The plugins registry proved
-- redundant: custom tools (kind='http'), agents, and Forge cover the same
-- ground, and nothing else in the codebase reads the table (only the removed
-- PluginsPage ever queried it). Its RLS policies drop with the table.
--
-- Idempotent so re-runs (and DBs that never applied 0018) are safe.

drop table if exists public.plugins;
