-- Artifact and file visibility propagation: extend migration 0122 to include
-- artifacts and files. When a collection becomes workspace-visible, make all
-- private artifacts and files in it 'unlisted' (the closest equivalent to
-- workspace-shared for the private/unlisted/public visibility model). And when
-- artifacts/files are added to a workspace collection, set them to unlisted.
--
-- This completes the visibility propagation system started in 0122, which
-- handled todos, links, whiteboards, card_boards, user_tables, and inbox_messages
-- (all of which use the private/workspace visibility model). Artifacts and files
-- use the private/unlisted/public model, so 'unlisted' is the workspace equivalent.

-- ---------------------------------------------------------------------------
-- Update the helper function to include artifacts and files
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

  -- Update artifacts in this collection (private → unlisted)
  -- Artifacts don't have a 'workspace' visibility option, so use 'unlisted'
  -- which allows anyone with the link to access it (similar to workspace sharing)
  update public.artifacts a
  set visibility = 'unlisted'
  from public.collection_artifacts ca
  where ca.collection_id = p_collection_id
    and ca.artifact_id = a.id
    and a.visibility = 'private';

  -- Update files in this collection (private → unlisted)
  -- Files follow the same visibility model as artifacts
  update public.files f
  set visibility = 'unlisted'
  from public.collection_files cf
  where cf.collection_id = p_collection_id
    and cf.file_id = f.id
    and f.visibility = 'private';
end;
$$;

-- ---------------------------------------------------------------------------
-- Triggers: when an artifact or file is added to a workspace collection,
-- set its visibility to unlisted
-- ---------------------------------------------------------------------------

-- Trigger for artifacts
create or replace function public.on_artifact_added_to_collection()
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

  -- If the collection is workspace-visible, set the artifact to unlisted
  if v_collection_visibility = 'workspace' then
    update public.artifacts
    set visibility = 'unlisted'
    where id = NEW.artifact_id
      and visibility = 'private';
  end if;

  return NEW;
end;
$$;

drop trigger if exists artifact_added_to_collection on public.collection_artifacts;
create trigger artifact_added_to_collection
  after insert on public.collection_artifacts
  for each row
  execute function public.on_artifact_added_to_collection();

-- Trigger for files
create or replace function public.on_file_added_to_collection()
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

  -- If the collection is workspace-visible, set the file to unlisted
  if v_collection_visibility = 'workspace' then
    update public.files
    set visibility = 'unlisted'
    where id = NEW.file_id
      and visibility = 'private';
  end if;

  return NEW;
end;
$$;

drop trigger if exists file_added_to_collection on public.collection_files;
create trigger file_added_to_collection
  after insert on public.collection_files
  for each row
  execute function public.on_file_added_to_collection();
