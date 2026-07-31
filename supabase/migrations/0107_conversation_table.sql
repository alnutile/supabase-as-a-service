-- Chat-with-this-table: link a conversation to a user table so the Tables grid
-- can host a PERSISTENT, table-scoped chat dock (the "Ask AI" panel) — the same
-- pattern as the Cards editor's BoardChatPanel (migration 0076,
-- conversations.card_board_id). The panel finds-or-creates the conversation for
-- (owner, table_id); its messages persist in the same conversations/messages
-- tables the main Chat uses, so the thread survives, syncs over realtime, and
-- shows up in the chat list.
--
-- Owner-only RLS on `conversations` already covers this new column (each member
-- gets their own thread about a shared table); nothing else to change. The
-- reference is to the `user_tables` registry row (not the physical ut_* table),
-- so dropping a table (which deletes its registry row) cascades the thread away.
alter table public.conversations
  add column if not exists table_id uuid references public.user_tables (id) on delete cascade;

create index if not exists conversations_table_idx
  on public.conversations (owner_id, table_id) where table_id is not null;
