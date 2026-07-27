-- Add 'workspace' visibility option to artifacts so they can be shared with
-- workspace members (like todos, links, collections) independently of the
-- public/unlisted external sharing options.
--
-- NOTE: this migration ONLY adds the enum value. Postgres forbids using a newly
-- added enum value in the SAME transaction that adds it, and `supabase db push`
-- (and the tenant fan-out) wrap each migration file in one transaction — so the
-- policy that references `visibility = 'workspace'` lives in 0098, which runs in
-- a later transaction after this value has committed.
alter type public.visibility add value if not exists 'workspace';
