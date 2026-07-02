-- Tables (the "Tables" feature — real Postgres ut_* tables) can now be filed into
-- collections, exactly like artifacts / files / to-dos. Chatting with the
-- collection then includes a preview of the table's rows. RLS inherits the
-- collection's visibility (the access logic lives in the collections table).
create table public.collection_tables (
  collection_id uuid not null references public.collections (id) on delete cascade,
  table_id uuid not null references public.user_tables (id) on delete cascade,
  added_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (collection_id, table_id)
);
create index collection_tables_table_idx on public.collection_tables (table_id);

alter table public.collection_tables enable row level security;
grant select, insert, delete on public.collection_tables to authenticated;

create policy "Read table memberships of visible collections"
  on public.collection_tables for select
  using (exists (select 1 from public.collections c where c.id = collection_id));

create policy "Add tables to collaborable collections"
  on public.collection_tables for insert
  with check (
    exists (
      select 1 from public.collections c
      where c.id = collection_id
        and (
          c.owner_id = auth.uid()
          or c.visibility = 'workspace'
          or exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin)
        )
    )
  );

create policy "Remove tables from collaborable collections"
  on public.collection_tables for delete
  using (
    exists (
      select 1 from public.collections c
      where c.id = collection_id
        and (
          c.owner_id = auth.uid()
          or c.visibility = 'workspace'
          or exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin)
        )
    )
  );
