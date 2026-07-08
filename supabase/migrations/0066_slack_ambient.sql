-- Slack ambient participation ("Claude Tag" style).
--
-- Today the bot only answers when @mentioned. Ambient mode lets a bound channel
-- opt into the bot *listening to every message* and a cheap model deciding —
-- guided by a per-channel participation prompt — whether to chime in unprompted.
--
-- Everything stays opt-in per channel: `mode` defaults to 'mention' (today's
-- exact behavior, no regression). When set to 'ambient':
--   * `participation_prompt` steers WHEN the bot should speak ("chime in on
--     billing questions; stay quiet for banter").
--   * `gate_model` optionally overrides the model used for the cheap
--     should-I-respond? decision — any OpenRouter slug (e.g.
--     'anthropic/claude-haiku-4.5'); null falls back to the `utility` profile.
--   * `capture_messages` (default true) also files every channel message into
--     the unified inbox (`inbox_messages`, source='slack'), so channel traffic is
--     searchable, filable into collections, and drives event listeners even when
--     the bot stays silent.
--
-- No RLS changes: the existing slack_channel_bindings policies cover these rows.

alter table public.slack_channel_bindings
  add column if not exists mode text not null default 'mention' check (mode in ('mention', 'ambient')),
  add column if not exists participation_prompt text not null default '',
  add column if not exists gate_model text,
  add column if not exists capture_messages boolean not null default true;
