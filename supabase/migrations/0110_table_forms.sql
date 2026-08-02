-- Public write-forms for user tables ("Tables" feature): let an owner accept
-- ANONYMOUS submissions into ONE of their tables from a public artifact/page —
-- e.g. a contact form or a signup sheet baked into a shared HTML artifact.
--
-- This is the WRITE half only (reads are a deliberate follow-up: a public read
-- would expose everyone's rows, so it needs a curated surface, not this table).
--
-- Why this is safe even though the ut_* tables never grant `anon`:
--   * Submissions do NOT go through the browser's anon key. The sandboxed
--     artifact iframe (opaque origin, no session) POSTs to the public
--     `form-submit` edge function, which runs as the service role and enforces
--     everything in code — so no anon grant/RLS hole is ever opened on ut_*.
--   * A form is OWNER OPT-IN, per table, with an explicit column allow-list
--     (`fields`). The function inserts ONLY those columns, forces owner_id to the
--     form's owner, is insert-only, validates required fields + types, and caps
--     submissions per hour. Same deterministic-gate philosophy as
--     `webhooks.allow_tools`.
--   * The form is addressed by an opaque `token` (secret-URL capability, same
--     trust model as `webhooks.token`) — safe to bake into public HTML.

create table if not exists public.table_forms (
  id uuid primary key default gen_random_uuid(),
  table_id uuid not null references public.user_tables (id) on delete cascade,
  owner_id uuid not null references auth.users (id) on delete cascade,
  name text not null default 'Untitled form',
  -- Opaque capability token embedded in the public form (unguessable, like
  -- webhooks.token). Rotatable by deleting + recreating the form.
  token text not null unique default replace(gen_random_uuid()::text, '-', ''),
  -- Column allow-list: [{ "key": "email", "required": true }, ...]. Only these
  -- columns may be written, and `required` ones must be present. Validated
  -- against the table's REAL columns at submit time (unknown keys are dropped).
  fields jsonb not null default '[]'::jsonb,
  active boolean not null default true,
  -- Abuse control: the public endpoint is unauthenticated, so cap submissions
  -- per rolling hour (per form). Enforced in the edge function via activity_log.
  max_per_hour integer not null default 60,
  submission_count bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists table_forms_owner_idx on public.table_forms (owner_id, updated_at desc);
create index if not exists table_forms_table_idx on public.table_forms (table_id);

alter table public.table_forms enable row level security;
grant select, insert, update, delete on public.table_forms to authenticated;

-- Owner (or admin) manages their own forms. The PUBLIC submit path never reads
-- through RLS — the edge function resolves the token with the service role — so
-- there is deliberately no anon policy here.
--
-- The `with check` also requires that the form's owner can actually WRITE the
-- referenced table (owns it, or it's workspace-shared, or they're an admin), so
-- a member can't mint a form that funnels rows into a table they can't access.
-- (Re-verified in the edge function too, in case the table's visibility later
-- changes.)
drop policy if exists "Manage own table_forms" on public.table_forms;
create policy "Manage own table_forms"
  on public.table_forms for all
  using (
    owner_id = auth.uid()
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin)
  )
  with check (
    owner_id = auth.uid()
    and exists (
      select 1 from public.user_tables t
      where t.id = table_id
        and (
          t.owner_id = auth.uid()
          or t.visibility = 'workspace'
          or exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin)
        )
    )
  );

-- Atomic submission counter bump, called by the service-role `form-submit`
-- function after a successful insert (a friendly running total for the owner's
-- UI). Not on the public RPC surface — service role only.
create or replace function public.increment_form_submission_count(p_form_id uuid)
  returns void
  language sql
  security definer
  set search_path = ''
as $$
  update public.table_forms
    set submission_count = submission_count + 1
    where id = p_form_id;
$$;
revoke execute on function public.increment_form_submission_count(uuid) from anon, public, authenticated;
grant execute on function public.increment_form_submission_count(uuid) to service_role;

-- Keep updated_at fresh on edits (mirrors the other feature tables).
create or replace function public.touch_table_forms_updated_at()
  returns trigger
  language plpgsql
  set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;
revoke execute on function public.touch_table_forms_updated_at() from anon, public, authenticated;

drop trigger if exists table_forms_touch_updated_at on public.table_forms;
create trigger table_forms_touch_updated_at
  before update on public.table_forms
  for each row execute function public.touch_table_forms_updated_at();
