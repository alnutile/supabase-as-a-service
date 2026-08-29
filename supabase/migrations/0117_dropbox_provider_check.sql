-- Fix: the Dropbox integration (0115) widened the integrations *kind* check to
-- include 'dropbox' but left the separate *provider* check untouched. That
-- constraint (from 0016) still only allowed ('postmark', 'resend'), so
-- `set_dropbox_integration` failed on insert with:
--   new row for relation "integrations" violates check constraint
--   "integrations_provider_check"
-- Widen the provider allow-list to include 'dropbox'.
alter table public.integrations drop constraint if exists integrations_provider_check;
alter table public.integrations add constraint integrations_provider_check
  check (provider in ('postmark', 'resend', 'dropbox'));
