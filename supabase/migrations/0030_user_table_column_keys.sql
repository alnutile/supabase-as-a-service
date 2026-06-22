-- Fix: create_user_table dropped columns when the caller passed only {label,type}
-- (the loop required a `key`/`name` field). Derive the physical key from the
-- label when no explicit key is given, so the Tables UI, chat builtins, and MCP
-- all behave the same. create-or-replace only — no schema change.
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
    v_label := coalesce(
      nullif(btrim(coalesce(v_col->>'label', '')), ''),
      nullif(btrim(coalesce(v_col->>'name', '')), '')
    );
    v_key := lower(btrim(coalesce(v_col->>'key', v_col->>'name', '')));
    v_type := coalesce(v_col->>'type', 'text');

    -- No explicit key? Derive one from the label (matches the client slugifier).
    if v_key = '' and v_label is not null then
      v_key := btrim(regexp_replace(lower(v_label), '[^a-z0-9]+', '_', 'g'), '_');
      if v_key <> '' and v_key !~ '^[a-z]' then v_key := 'c_' || v_key; end if;
    end if;
    if v_key = '' then continue; end if;
    v_label := coalesce(v_label, v_key);

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

  execute format(
    'create policy "rows_access" on public.%I for all
       using (exists (select 1 from public.user_tables t where t.id = %L))
       with check (exists (select 1 from public.user_tables t where t.id = %L))',
    v_phys, v_id, v_id
  );

  insert into public.user_tables (id, name, description, physical_name, owner_id, columns, visibility)
  values (v_id, btrim(p_name), '', v_phys, v_owner, v_norm, v_vis)
  returning * into v_row;

  notify pgrst, 'reload schema';
  return v_row;
end;
$$;
