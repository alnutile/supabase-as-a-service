-- Switch the AI provider to OpenRouter.
--
-- model_profiles.provider was locked to 'anthropic' (the seam for later). We now
-- widen it to allow 'openrouter', make 'openrouter' the default, and re-point the
-- two built-in profiles at OpenRouter slugs for the equivalent Claude models.
-- Model ids are now OpenRouter slugs (e.g. 'anthropic/claude-sonnet-4.5'); admins
-- can re-point any profile to any OpenRouter model in Settings → Models.

-- Relax the CHECK to accept 'openrouter' (keep 'anthropic' valid so any existing
-- rows / future re-points don't violate the constraint).
alter table public.model_profiles
  drop constraint if exists model_profiles_provider_check;

alter table public.model_profiles
  add constraint model_profiles_provider_check
  check (provider in ('openrouter', 'anthropic'));

alter table public.model_profiles
  alter column provider set default 'openrouter';

-- Re-point the seeded built-in profiles to OpenRouter slugs.
update public.model_profiles
  set provider = 'openrouter', model = 'anthropic/claude-sonnet-4.5', updated_at = now()
  where key = 'orchestrator';

update public.model_profiles
  set provider = 'openrouter', model = 'anthropic/claude-haiku-4.5', updated_at = now()
  where key = 'utility';
