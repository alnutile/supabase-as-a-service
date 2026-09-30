-- Set replica identity full on features table so Realtime UPDATE events include
-- all columns, not just the primary key + changed columns. Without this, when a
-- PR link is synced (the edge function updates pr_url/pr_number/pr_state), the
-- Realtime payload.new only includes those fields, causing the Features board's
-- upsertFeature to replace the full row with an incomplete one — the card then
-- renders without its title/description/etc, or the PR link doesn't show if those
-- fields are undefined. With replica identity full, the UPDATE event carries the
-- complete row, so the board renders correctly.
--
-- This is the same pattern as todos (0120) and whiteboards/card_boards (their
-- original migrations), which all use Realtime for live multi-device updates.
-- Fixes issue #406.

alter table public.features replica identity full;
