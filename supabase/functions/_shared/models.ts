// Resolves the model id for a named job ("profile key") from the model_profiles
// table — the source of truth, admin-managed in Settings → Models. Features bind
// to a profile key (never a model id). Model ids are OpenRouter slugs (e.g.
// 'anthropic/claude-sonnet-4.5'). Falls back to the env/hardcoded default only
// when the row can't be loaded, so deleting or renaming a profile row never
// breaks a run. Resolved once per request (no cross-request caching) so an admin
// edit applies to the very next message.

type ProfileKey = 'orchestrator' | 'utility'

// OPENROUTER_MODEL is the primary override; ANTHROPIC_MODEL is read as a legacy
// fallback so older deployments don't hard-break, but note it must now be an
// OpenRouter slug, not a bare Anthropic model id.
const FALLBACK: Record<ProfileKey, string> = {
  orchestrator: Deno.env.get('OPENROUTER_MODEL') ?? Deno.env.get('ANTHROPIC_MODEL') ?? 'openai/gpt-5.6-luna',
  utility: 'anthropic/claude-haiku-4.5',
}

// deno-lint-ignore no-explicit-any
export async function resolveModel(db: any, key: ProfileKey): Promise<string> {
  try {
    if (!db) return FALLBACK[key]
    const { data } = await db.from('model_profiles').select('model').eq('key', key).maybeSingle()
    return (data?.model as string) || FALLBACK[key]
  } catch {
    return FALLBACK[key]
  }
}
