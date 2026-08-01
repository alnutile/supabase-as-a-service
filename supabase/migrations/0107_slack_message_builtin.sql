-- Seed the `send_slack_message` builtin tool.
--
-- The proactive counterpart to the reactive slack-events reply path: a
-- scheduled / loop / webhook / chat agent can now POST into Slack (e.g. a daily
-- summary to #standup) instead of only answering an @mention. The handler lives
-- in supabase/functions/_shared/builtins.ts (runBuiltin), reads the bot token
-- from Vault via read_slack_secrets, rate-limits per hour, and logs every post.
--
-- Exfiltration-capable like send_email, so it's an ordinary tool row: admin
-- activation, agent tool_ids scoping, and the webhooks.allow_tools gate all
-- apply. Left INACTIVE by default (is_active = false) — an admin turns it on in
-- Settings once Slack is connected. Idempotent so re-applying is a no-op.
insert into public.tools (name, description, input_schema, kind, is_builtin, is_active, created_by)
select
  'send_slack_message',
  'Post a message into a Slack channel. Use to proactively send something to the team (a summary, an alert, a reminder) rather than waiting to be @mentioned. Requires Slack to be connected and the bot to be in the target channel.',
  '{"type":"object","properties":{"channel":{"type":"string","description":"Slack channel id (e.g. C0123456) or name (e.g. #general). The bot must be a member of the channel."},"text":{"type":"string","description":"The message to post. Markdown is converted to Slack formatting."},"thread_ts":{"type":"string","description":"Optional: the ts of a parent message to reply in-thread."}},"required":["channel","text"]}'::jsonb,
  'builtin',
  true,
  false,
  (select id from public.profiles order by created_at asc limit 1)
where not exists (select 1 from public.tools where name = 'send_slack_message');
