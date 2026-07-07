-- Agents in collections — let an agent be filed into a collection, exactly like
-- artifacts / files / to-dos / links / tables already can be.
--
-- `collection_agents` is the many-to-many join (a mirror of collection_links).
-- Its RLS inherits the parent collection's visibility (the access logic lives in
-- ONE place, the collections table), so a workspace collection's members can file
-- agents into it and a private one stays owner+admin only.
--
-- We also extend the single generic `emit_collection_item_added()` trigger from
-- 0063 to recognise the new join table (mapping it to the `agent` item type) and
-- attach the trigger to `collection_agents`, so filing an agent into a collection
-- emits the same `collection.item_added` event as every other content type.

-- ---------------------------------------------------------------------------
-- collection_agents (many-to-many; mirrors collection_links exactly)
-- ---------------------------------------------------------------------------
create table public.collection_agents (
  collection_id uuid not null references public.collections (id) on delete cascade,
  agent_id uuid not null references public.agents (id) on delete cascade,
  added_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (collection_id, agent_id)
);
create index collection_agents_agent_idx on public.collection_agents (agent_id);

alter table public.collection_agents enable row level security;
grant select, insert, delete on public.collection_agents to authenticated;

-- A membership row is visible when its parent collection is visible.
create policy "Read agent memberships of visible collections"
  on public.collection_agents for select
  using (exists (select 1 from public.collections c where c.id = collection_id));

-- Anyone who can collaborate on the collection may file agents into it.
create policy "Add agents to collaborable collections"
  on public.collection_agents for insert
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

create policy "Remove agents from collaborable collections"
  on public.collection_agents for delete
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

-- ---------------------------------------------------------------------------
-- Teach the generic collection-membership trigger about `collection_agents`
-- (re-declare the whole function so the case mapping stays in one place), then
-- attach it to the new join table.
-- ---------------------------------------------------------------------------
create or replace function public.emit_collection_item_added()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_item_type text;
  v_item_id uuid;
  v_owner uuid;
  v_vis text;
begin
  v_item_type := case tg_table_name
    when 'collection_artifacts' then 'artifact'
    when 'collection_files' then 'file'
    when 'collection_todos' then 'todo'
    when 'collection_links' then 'link'
    when 'collection_tables' then 'table'
    when 'collection_agents' then 'agent'
    when 'collection_inbox_messages' then 'inbox_message'
    else 'item' end;
  v_item_id := (to_jsonb(new) ->> (v_item_type || '_id'))::uuid;
  select owner_id, visibility into v_owner, v_vis from public.collections where id = new.collection_id;
  perform public.emit_event(
    'collection.item_added', v_item_type, v_item_id,
    coalesce(new.added_by, v_owner),
    'Added a ' || v_item_type || ' to a collection',
    jsonb_build_object('collection_id', new.collection_id, 'item_type', v_item_type, 'item_id', v_item_id),
    case when coalesce(v_vis, 'workspace') = 'private' then 'private' else 'workspace' end
  );
  return new;
end; $$;

create trigger trg_emit_collection_agent
  after insert on public.collection_agents
  for each row execute function public.emit_collection_item_added();
