-- Collection visibility propagation: when a collection becomes workspace-visible,
-- make all items in it workspace-visible too. And when items are added to a
-- workspace collection, set their visibility to workspace.
--
-- This only applies to content types that support the `workspace` visibility:
-- todos, links, whiteboards, card_boards, user_tables, and inbox_messages.
-- Artifacts and files use a different visibility model (private/unlisted/public)
-- where workspace sharing happens through the collection mechanism itself.

-- ---------------------------------------------------------------------------
-- Helper function: update item visibility to workspace
-- ---------------------------------------------------------------------------
create or replace function public.propagate_workspace_visibility_to_items(p_collection_id uuid)
  returns void
  language plpgsql
  security definer
  set search_path = public
as $$
begin
  -- Update todos in this collection
  update public.todos t
  set visibility = 'workspace'
  from public.collection_todos ct
  where ct.collection_id = p_collection_id
    and ct.todo_id = t.id
    and t.visibility = 'private';

  -- Update links in this collection
  update public.links l
  set visibility = 'workspace'
  from public.collection_links cl
  where cl.collection_id = p_collection_id
    and cl.link_id = l.id
    and l.visibility = 'private';

  -- Update whiteboards in this collection
  update public.whiteboards w
  set visibility = 'workspace'
  from public.collection_whiteboards cw
  where cw.collection_id = p_collection_id
    and cw.whiteboard_id = w.id
    and w.visibility = 'private';

  -- Update card boards in this collection
  update public.card_boards cb
  set visibility = 'workspace'
  from public.collection_card_boards ccb
  where ccb.collection_id = p_collection_id
    and ccb.card_board_id = cb.id
    and cb.visibility = 'private';

  -- Update user tables in this collection
  update public.user_tables ut
  set visibility = 'workspace'
  from public.collection_tables ct
  where ct.collection_id = p_collection_id
    and ct.table_id = ut.id
    and ut.visibility = 'private';

  -- Update inbox messages in this collection
  update public.inbox_messages im
  set visibility = 'workspace'
  from public.collection_inbox_messages cim
  where cim.collection_id = p_collection_id
    and cim.inbox_message_id = im.id
    and im.visibility = 'private';
end;
$$;

-- ---------------------------------------------------------------------------
-- Trigger: when a collection's visibility changes to workspace, propagate
-- ---------------------------------------------------------------------------
create or replace function public.on_collection_visibility_change()
  returns trigger
  language plpgsql
  security definer
  set search_path = public
as $$
begin
  -- If collection just became workspace-visible, update all items in it
  if NEW.visibility = 'workspace' and (OLD is null or OLD.visibility <> 'workspace') then
    perform public.propagate_workspace_visibility_to_items(NEW.id);
  end if;
  return NEW;
end;
$$;

drop trigger if exists collection_visibility_change on public.collections;
create trigger collection_visibility_change
  after insert or update of visibility on public.collections
  for each row
  execute function public.on_collection_visibility_change();

-- ---------------------------------------------------------------------------
-- Triggers: when an item is added to a workspace collection, set its visibility
-- ---------------------------------------------------------------------------

-- Trigger for todos
create or replace function public.on_todo_added_to_collection()
  returns trigger
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  v_collection_visibility text;
begin
  -- Check if the collection is workspace-visible
  select visibility into v_collection_visibility
  from public.collections
  where id = NEW.collection_id;

  -- If the collection is workspace-visible, set the todo to workspace too
  if v_collection_visibility = 'workspace' then
    update public.todos
    set visibility = 'workspace'
    where id = NEW.todo_id
      and visibility = 'private';
  end if;

  return NEW;
end;
$$;

drop trigger if exists todo_added_to_collection on public.collection_todos;
create trigger todo_added_to_collection
  after insert on public.collection_todos
  for each row
  execute function public.on_todo_added_to_collection();

-- Trigger for links
create or replace function public.on_link_added_to_collection()
  returns trigger
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  v_collection_visibility text;
begin
  select visibility into v_collection_visibility
  from public.collections
  where id = NEW.collection_id;

  if v_collection_visibility = 'workspace' then
    update public.links
    set visibility = 'workspace'
    where id = NEW.link_id
      and visibility = 'private';
  end if;

  return NEW;
end;
$$;

drop trigger if exists link_added_to_collection on public.collection_links;
create trigger link_added_to_collection
  after insert on public.collection_links
  for each row
  execute function public.on_link_added_to_collection();

-- Trigger for whiteboards
create or replace function public.on_whiteboard_added_to_collection()
  returns trigger
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  v_collection_visibility text;
begin
  select visibility into v_collection_visibility
  from public.collections
  where id = NEW.collection_id;

  if v_collection_visibility = 'workspace' then
    update public.whiteboards
    set visibility = 'workspace'
    where id = NEW.whiteboard_id
      and visibility = 'private';
  end if;

  return NEW;
end;
$$;

drop trigger if exists whiteboard_added_to_collection on public.collection_whiteboards;
create trigger whiteboard_added_to_collection
  after insert on public.collection_whiteboards
  for each row
  execute function public.on_whiteboard_added_to_collection();

-- Trigger for card boards
create or replace function public.on_card_board_added_to_collection()
  returns trigger
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  v_collection_visibility text;
begin
  select visibility into v_collection_visibility
  from public.collections
  where id = NEW.collection_id;

  if v_collection_visibility = 'workspace' then
    update public.card_boards
    set visibility = 'workspace'
    where id = NEW.card_board_id
      and visibility = 'private';
  end if;

  return NEW;
end;
$$;

drop trigger if exists card_board_added_to_collection on public.collection_card_boards;
create trigger card_board_added_to_collection
  after insert on public.collection_card_boards
  for each row
  execute function public.on_card_board_added_to_collection();

-- Trigger for user tables
create or replace function public.on_table_added_to_collection()
  returns trigger
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  v_collection_visibility text;
begin
  select visibility into v_collection_visibility
  from public.collections
  where id = NEW.collection_id;

  if v_collection_visibility = 'workspace' then
    update public.user_tables
    set visibility = 'workspace'
    where id = NEW.table_id
      and visibility = 'private';
  end if;

  return NEW;
end;
$$;

drop trigger if exists table_added_to_collection on public.collection_tables;
create trigger table_added_to_collection
  after insert on public.collection_tables
  for each row
  execute function public.on_table_added_to_collection();

-- Trigger for inbox messages
create or replace function public.on_message_added_to_collection()
  returns trigger
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  v_collection_visibility text;
begin
  select visibility into v_collection_visibility
  from public.collections
  where id = NEW.collection_id;

  if v_collection_visibility = 'workspace' then
    update public.inbox_messages
    set visibility = 'workspace'
    where id = NEW.inbox_message_id
      and visibility = 'private';
  end if;

  return NEW;
end;
$$;

drop trigger if exists message_added_to_collection on public.collection_inbox_messages;
create trigger message_added_to_collection
  after insert on public.collection_inbox_messages
  for each row
  execute function public.on_message_added_to_collection();
