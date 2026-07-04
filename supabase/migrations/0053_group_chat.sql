-- Group chat: humans can share a conversation with other workspace members and
-- talk to EACH OTHER; the AI only pipes in when someone writes @ai. The AI
-- gating is client behavior (ChatPage only calls the chat function on @ai in a
-- shared thread) — this migration is the data model that makes the thread
-- shared: membership, RLS, and a member directory.
--
-- `conversation_members` is who else is in a thread (the owner is implicit).
-- Access = owner OR member, resolved by a SECURITY DEFINER helper so the
-- conversations/messages policies can consult the join table without RLS
-- recursion. Members can read the whole thread, post messages AS THEMSELVES
-- (owner_id = auth.uid() is enforced on insert), add more people, and leave;
-- only the thread owner deletes the conversation or removes others.

create table public.conversation_members (
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  added_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (conversation_id, user_id)
);
create index conversation_members_user_idx on public.conversation_members (user_id);

alter table public.conversation_members enable row level security;
grant select, insert, delete on public.conversation_members to authenticated;

-- Owner-or-member check that bypasses RLS (used inside policies).
create or replace function public.can_access_conversation(p_conv uuid)
  returns boolean
  language sql
  stable
  security definer
  set search_path = public
as $$
  select exists (
    select 1 from public.conversations c
    where c.id = p_conv and c.owner_id = auth.uid()
  ) or exists (
    select 1 from public.conversation_members m
    where m.conversation_id = p_conv and m.user_id = auth.uid()
  )
$$;
revoke execute on function public.can_access_conversation(uuid) from anon, public;
grant execute on function public.can_access_conversation(uuid) to authenticated;

create policy "Participants see the member list"
  on public.conversation_members for select
  using (public.can_access_conversation(conversation_id));

-- Anyone already in the thread may bring in another member.
create policy "Participants add members"
  on public.conversation_members for insert
  with check (public.can_access_conversation(conversation_id));

-- Leave yourself; the owner may remove anyone.
create policy "Leave or owner-remove members"
  on public.conversation_members for delete
  using (
    user_id = auth.uid()
    or exists (
      select 1 from public.conversations c
      where c.id = conversation_id and c.owner_id = auth.uid()
    )
  );

-- ---------------------------------------------------------------------------
-- conversations / messages: members join the owner-only policies (additive —
-- the original "Owners manage …" FOR ALL policies stay untouched).
-- ---------------------------------------------------------------------------
create policy "Members read shared conversations"
  on public.conversations for select
  using (public.can_access_conversation(id));

-- Members may touch updated_at / rename; delete stays owner-only.
create policy "Members update shared conversations"
  on public.conversations for update
  using (public.can_access_conversation(id));

create policy "Members read shared messages"
  on public.messages for select
  using (public.can_access_conversation(conversation_id));

-- Members post as themselves — the sender can't be spoofed.
create policy "Members write shared messages"
  on public.messages for insert
  with check (owner_id = auth.uid() and public.can_access_conversation(conversation_id));

-- Realtime: member-list changes stream to open threads (messages and
-- conversations are already in the publication from 0001).
alter publication supabase_realtime add table public.conversation_members;

-- ---------------------------------------------------------------------------
-- Member directory: profiles RLS is owner-only, so the "add people" picker
-- needs a deliberate, minimal directory of workspace members (this is an
-- invite-only intranet — names/emails are workspace-visible by design).
-- ---------------------------------------------------------------------------
create or replace function public.list_workspace_members()
  returns table (id uuid, email text, display_name text)
  language sql
  stable
  security definer
  set search_path = public
as $$
  select p.id, p.email, p.display_name
  from public.profiles p
  order by coalesce(p.display_name, p.email)
$$;
revoke execute on function public.list_workspace_members() from anon, public;
grant execute on function public.list_workspace_members() to authenticated;
