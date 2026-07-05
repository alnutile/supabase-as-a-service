-- Pin a conversation so it floats to the top of the chat list. A plain boolean
-- on the conversation; the existing owner FOR ALL policy and the members-update
-- policy (0053) already allow toggling it, so no new RLS is needed. The chat
-- list orders pinned rows first, then by recency.
alter table public.conversations
  add column if not exists pinned boolean not null default false;
