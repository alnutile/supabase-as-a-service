-- Refresh the seeded default models.
--
-- Model defaults move over time. Re-point the two built-in profiles at the
-- current defaults (orchestrator → openai/gpt-5.6-luna). Admins can still
-- re-point any profile to any OpenRouter slug in Settings → Models; this just
-- updates the shipped defaults for fresh workspaces and existing ones alike.
-- Model ids are OpenRouter slugs.

update public.model_profiles
  set provider = 'openrouter', model = 'openai/gpt-5.6-luna', updated_at = now()
  where key = 'orchestrator';

update public.model_profiles
  set provider = 'openrouter', model = 'anthropic/claude-haiku-4.5', updated_at = now()
  where key = 'utility';
