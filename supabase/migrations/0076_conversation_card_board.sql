-- Chat-with-this-board: link a conversation to a card board so the Cards editor
-- can host a PERSISTENT chat panel (unlike the ephemeral CollectionsPage bubble).
-- The panel finds-or-creates the conversation for (owner, card_board_id) and its
-- messages persist in the same conversations/messages tables the main Chat uses —
-- so the thread survives, syncs over realtime, and shows up in the chat list.
--
-- Owner-only RLS on `conversations` already covers this new column (each member
-- gets their own thread about a shared board); nothing else to change.
alter table public.conversations
  add column if not exists card_board_id uuid references public.card_boards (id) on delete cascade;

create index if not exists conversations_card_board_idx
  on public.conversations (owner_id, card_board_id) where card_board_id is not null;
