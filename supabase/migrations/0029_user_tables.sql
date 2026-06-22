-- User-defined tables ("Tables" feature): an Airtable-like UI backed by REAL
-- Postgres tables, so the workspace keeps the SQL power Airtable lacks.
--
-- Design:
--   * `public.user_tables` is a REGISTRY of each user table's metadata (display
--     name, the physical table name, the column spec, owner, visibility).
--   * Each user table is a REAL table created in the `public` schema with the
--     prefix `ut_<uuid>` so PostgREST auto-exposes it and the browser can do
--     ordinary CRUD against it (RLS guards the rows).
--   * Browsers NEVER run DDL. All structural changes go through the
--     security-definer RPCs below, which validate every identifier with
--     format(%I) + an allow-list of column types, so there is no SQL injection
--     surface even though any signed-in member can create tables.
--
-- Access model (mirrors documents/knowledge): a table is `private` (owner +
-- admins only) or `workspace` (every member can read AND write — collaborative,
-- like a shared Airtable base). The per-table RLS policy simply checks whether
-- the caller can see the matching `user_tables` registry row, so the access
-- logic lives in ONE place (the registry's RLS) and the physical tables inherit
-- it.

-- ---------------------------------------------------------------------------
-- Registry
-- ---------------------------------------------------------------------------
create table public.user_tables (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text not null default '',
  physical_name text not null unique,
  owner_id uuid not null references auth.users (id) on delete cascade,
  columns jsonb not null default '[]'::jsonb, -- [{key,label,type}]
  visibility text not null default 'private' check (visibility in ('private', 'workspace')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index user_tables_owner_idx on public.user_tables (owner_id, updated_at desc);

alter table public.user_tables enable row level security;
grant select on public.user_tables to authenticated;

-- Read your own tables, any workspace-shared table, or (admins) all of them.
create policy "Read own or shared user_tables"
  on public.user_tables for select
  using (
    owner_id = auth.uid()
    or visibility = 'workspace'
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin)
  );

-- NOTE: there are deliberately NO insert/update/delete policies. Every mutation
-- (create table, add/drop column, rename, share, drop) goes through the
-- security-definer RPCs below, which run as the table owner and bypass RLS. This
-- keeps the physical_name / columns spec from ever being forged by a client.

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

-- Map a friendly column type to a concrete Postgres type. Returns null for an
-- unsupported type so the caller can reject it (the allow-list IS the gate).
create or replace function public._user_table_pgtype(p_type text)
  returns text
  language sql
  immutable
  set search_path = ''
as $$
  select case lower(coalesce(p_type, ''))
    when 'text' then 'text'
    when 'longtext' then 'text'
    when 'number' then 'numeric'
    when 'integer' then 'bigint'
    when 'boolean' then 'boolean'
    when 'checkbox' then 'boolean'
    when 'date' then 'date'
    when 'datetime' then 'timestamptz'
    when 'json' then 'jsonb'
    else null
  end
$$;

-- True when uid is an admin (used by the structural RPCs).
create or replace function public._is_admin(p_uid uuid)
  returns boolean
  language sql
  stable
  security definer
  set search_path = public
as $$
  select coalesce((select p.is_admin from public.profiles p where p.id = p_uid), false)
$$;
-- Internal helper for the structural RPCs only (they call it as the definer/owner);
-- not exposed on the REST RPC surface to signed-in users.
revoke execute on function public._is_admin(uuid) from anon, public, authenticated;
grant execute on function public._is_admin(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- create_user_table — create a real table + register it
-- ---------------------------------------------------------------------------
-- p_owner is honored ONLY for service-role callers (auth.uid() is null then);
-- an authenticated caller's own uid always wins, so owner can't be spoofed.
create or replace function public.create_user_table(
  p_name text,
  p_columns jsonb default '[]'::jsonb,
  p_visibility text default 'private',
  p_owner uuid default null
)
  returns public.user_tables
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  v_owner uuid := coalesce(auth.uid(), p_owner);
  v_id uuid := gen_random_uuid();
  v_phys text;
  v_vis text;
  v_col jsonb;
  v_key text;
  v_label text;
  v_type text;
  v_pgtype text;
  v_cols_ddl text := '';
  v_norm jsonb := '[]'::jsonb;
  v_seen text[] := array[]::text[];
  v_row public.user_tables;
begin
  if v_owner is null then
    raise exception 'Not authorized';
  end if;
  if coalesce(btrim(p_name), '') = '' then
    raise exception 'A table name is required';
  end if;

  v_vis := lower(coalesce(p_visibility, 'private'));
  if v_vis not in ('private', 'workspace') then v_vis := 'private'; end if;

  v_phys := 'ut_' || replace(v_id::text, '-', '');

  for v_col in select * from jsonb_array_elements(coalesce(p_columns, '[]'::jsonb))
  loop
    v_key := lower(btrim(coalesce(v_col->>'key', v_col->>'name', '')));
    v_label := coalesce(nullif(btrim(coalesce(v_col->>'label', '')), ''), v_key);
    v_type := coalesce(v_col->>'type', 'text');
    if v_key = '' then continue; end if;
    if v_key !~ '^[a-z][a-z0-9_]*$' then
      raise exception 'Invalid column name "%": use a letter then lowercase letters, numbers, or underscores', v_key;
    end if;
    if v_key in ('id', 'owner_id', 'created_at', 'updated_at') then
      raise exception 'Reserved column name "%"', v_key;
    end if;
    if v_key = any(v_seen) then
      raise exception 'Duplicate column name "%"', v_key;
    end if;
    v_pgtype := public._user_table_pgtype(v_type);
    if v_pgtype is null then
      raise exception 'Unsupported column type "%"', v_type;
    end if;
    v_seen := v_seen || v_key;
    v_cols_ddl := v_cols_ddl || format(', %I %s', v_key, v_pgtype);
    v_norm := v_norm || jsonb_build_object('key', v_key, 'label', v_label, 'type', lower(v_type));
  end loop;

  -- Create the real table. owner_id auto-fills from the inserting member.
  execute format(
    'create table public.%I (
       id uuid primary key default gen_random_uuid(),
       owner_id uuid not null default auth.uid() references auth.users (id) on delete set null,
       created_at timestamptz not null default now(),
       updated_at timestamptz not null default now()%s
     )',
    v_phys, v_cols_ddl
  );

  execute format('alter table public.%I enable row level security', v_phys);
  execute format('grant select, insert, update, delete on public.%I to authenticated, service_role', v_phys);

  -- Row access == "can you see this table's registry row?" (one source of truth).
  execute format(
    'create policy "rows_access" on public.%I for all
       using (exists (select 1 from public.user_tables t where t.id = %L))
       with check (exists (select 1 from public.user_tables t where t.id = %L))',
    v_phys, v_id, v_id
  );

  insert into public.user_tables (id, name, description, physical_name, owner_id, columns, visibility)
  values (v_id, btrim(p_name), '', v_phys, v_owner, v_norm, v_vis)
  returning * into v_row;

  -- Tell PostgREST to pick up the new table immediately (so the browser can
  -- query it right after creation instead of waiting for the next cache reload).
  notify pgrst, 'reload schema';
  return v_row;
end;
$$;
revoke execute on function public.create_user_table(text, jsonb, text, uuid) from anon, public;
grant execute on function public.create_user_table(text, jsonb, text, uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- add_user_column — add a column to an existing user table
-- ---------------------------------------------------------------------------
create or replace function public.add_user_column(
  p_table_id uuid,
  p_key text,
  p_type text default 'text',
  p_label text default null
)
  returns public.user_tables
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  v_t public.user_tables;
  v_key text := lower(btrim(coalesce(p_key, '')));
  v_label text := coalesce(nullif(btrim(coalesce(p_label, '')), ''), v_key);
  v_pgtype text := public._user_table_pgtype(p_type);
begin
  select * into v_t from public.user_tables where id = p_table_id;
  if not found then raise exception 'Table not found'; end if;
  if auth.uid() is not null and not (v_t.owner_id = auth.uid() or public._is_admin(auth.uid())) then
    raise exception 'Not authorized';
  end if;
  if v_key !~ '^[a-z][a-z0-9_]*$' then
    raise exception 'Invalid column name "%"', v_key;
  end if;
  if v_key in ('id', 'owner_id', 'created_at', 'updated_at') then
    raise exception 'Reserved column name "%"', v_key;
  end if;
  if exists (select 1 from jsonb_array_elements(v_t.columns) c where c->>'key' = v_key) then
    raise exception 'Column "%" already exists', v_key;
  end if;
  if v_pgtype is null then raise exception 'Unsupported column type "%"', p_type; end if;

  execute format('alter table public.%I add column %I %s', v_t.physical_name, v_key, v_pgtype);

  update public.user_tables
    set columns = columns || jsonb_build_object('key', v_key, 'label', v_label, 'type', lower(p_type)),
        updated_at = now()
    where id = p_table_id
    returning * into v_t;
  notify pgrst, 'reload schema';
  return v_t;
end;
$$;
revoke execute on function public.add_user_column(uuid, text, text, text) from anon, public;
grant execute on function public.add_user_column(uuid, text, text, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- drop_user_column — remove a column
-- ---------------------------------------------------------------------------
create or replace function public.drop_user_column(p_table_id uuid, p_key text)
  returns public.user_tables
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  v_t public.user_tables;
  v_key text := lower(btrim(coalesce(p_key, '')));
begin
  select * into v_t from public.user_tables where id = p_table_id;
  if not found then raise exception 'Table not found'; end if;
  if auth.uid() is not null and not (v_t.owner_id = auth.uid() or public._is_admin(auth.uid())) then
    raise exception 'Not authorized';
  end if;
  if v_key !~ '^[a-z][a-z0-9_]*$' then raise exception 'Invalid column name'; end if;
  if v_key in ('id', 'owner_id', 'created_at', 'updated_at') then
    raise exception 'Cannot drop a system column';
  end if;

  execute format('alter table public.%I drop column if exists %I', v_t.physical_name, v_key);

  update public.user_tables
    set columns = (select coalesce(jsonb_agg(c), '[]'::jsonb) from jsonb_array_elements(columns) c where c->>'key' <> v_key),
        updated_at = now()
    where id = p_table_id
    returning * into v_t;
  notify pgrst, 'reload schema';
  return v_t;
end;
$$;
revoke execute on function public.drop_user_column(uuid, text) from anon, public;
grant execute on function public.drop_user_column(uuid, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- update_user_table — rename / describe / re-share (metadata only)
-- ---------------------------------------------------------------------------
create or replace function public.update_user_table(
  p_table_id uuid,
  p_name text default null,
  p_description text default null,
  p_visibility text default null
)
  returns public.user_tables
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  v_t public.user_tables;
  v_vis text;
begin
  select * into v_t from public.user_tables where id = p_table_id;
  if not found then raise exception 'Table not found'; end if;
  if auth.uid() is not null and not (v_t.owner_id = auth.uid() or public._is_admin(auth.uid())) then
    raise exception 'Not authorized';
  end if;
  v_vis := lower(coalesce(p_visibility, v_t.visibility));
  if v_vis not in ('private', 'workspace') then v_vis := v_t.visibility; end if;

  update public.user_tables
    set name = coalesce(nullif(btrim(coalesce(p_name, '')), ''), v_t.name),
        description = coalesce(p_description, v_t.description),
        visibility = v_vis,
        updated_at = now()
    where id = p_table_id
    returning * into v_t;
  return v_t;
end;
$$;
revoke execute on function public.update_user_table(uuid, text, text, text) from anon, public;
grant execute on function public.update_user_table(uuid, text, text, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- drop_user_table — drop the real table + de-register it
-- ---------------------------------------------------------------------------
create or replace function public.drop_user_table(p_table_id uuid)
  returns void
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  v_t public.user_tables;
begin
  select * into v_t from public.user_tables where id = p_table_id;
  if not found then return; end if;
  if auth.uid() is not null and not (v_t.owner_id = auth.uid() or public._is_admin(auth.uid())) then
    raise exception 'Not authorized';
  end if;
  execute format('drop table if exists public.%I', v_t.physical_name);
  delete from public.user_tables where id = p_table_id;
  notify pgrst, 'reload schema';
end;
$$;
revoke execute on function public.drop_user_table(uuid) from anon, public;
grant execute on function public.drop_user_table(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Chat builtins (tools-as-data; kind 'builtin'), seeded like search_documents.
-- These let the assistant work with user tables from chat/agents/scheduler.
-- Each is routed through runBuiltin() in _shared/builtins.ts, which enforces the
-- same private/workspace access in code (builtins run with the service role).
-- ---------------------------------------------------------------------------
insert into public.tools (name, description, input_schema, kind, is_builtin, is_active, created_by)
select 'list_tables',
  'List the user-created data tables in this workspace (their names and columns) so you know what data exists and how to query it.',
  '{"type":"object","properties":{}}'::jsonb,
  'builtin', true, true,
  (select id from public.profiles order by created_at asc limit 1)
where not exists (select 1 from public.tools where name = 'list_tables');

insert into public.tools (name, description, input_schema, kind, is_builtin, is_active, created_by)
select 'query_table',
  'Read rows from a user-created data table. Identify the table by its name. Optionally pass simple equality filters and a row limit.',
  '{"type":"object","properties":{"table":{"type":"string","description":"The table name (or id)."},"filters":{"type":"object","description":"Optional column=value equality filters."},"limit":{"type":"integer","description":"Max rows to return (default 50, max 200)."}},"required":["table"]}'::jsonb,
  'builtin', true, true,
  (select id from public.profiles order by created_at asc limit 1)
where not exists (select 1 from public.tools where name = 'query_table');

insert into public.tools (name, description, input_schema, kind, is_builtin, is_active, created_by)
select 'add_table_row',
  'Add a row to a user-created data table. Identify the table by its name and pass the column values as an object.',
  '{"type":"object","properties":{"table":{"type":"string","description":"The table name (or id)."},"values":{"type":"object","description":"Column key/value pairs for the new row."}},"required":["table","values"]}'::jsonb,
  'builtin', true, true,
  (select id from public.profiles order by created_at asc limit 1)
where not exists (select 1 from public.tools where name = 'add_table_row');

insert into public.tools (name, description, input_schema, kind, is_builtin, is_active, created_by)
select 'create_table',
  'Create a new user data table. Provide a name and a list of columns (each with a label and a type: text, number, integer, boolean, date, datetime, or json).',
  '{"type":"object","properties":{"name":{"type":"string"},"visibility":{"type":"string","enum":["private","workspace"],"description":"workspace = shared with the team (default private)."},"columns":{"type":"array","items":{"type":"object","properties":{"label":{"type":"string"},"type":{"type":"string","enum":["text","number","integer","boolean","date","datetime","json"]}},"required":["label","type"]}}},"required":["name","columns"]}'::jsonb,
  'builtin', true, true,
  (select id from public.profiles order by created_at asc limit 1)
where not exists (select 1 from public.tools where name = 'create_table');
