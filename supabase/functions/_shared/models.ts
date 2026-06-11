// Resolves the model id for a named job ("profile key") from the model_profiles
// table — the source of truth, admin-managed in Settings → Models. Features bind
// to a profile key (never a model id). Falls back to the env/hardcoded default
// only when the row can't be loaded, so deleting or renaming a profile row never
// breaks a run. Resolved once per request (no cross-request caching) so an admin
// edit applies to the very next message.

type ProfileKey = 'orchestrator' | 'utility'

const FALLBACK: Record<ProfileKey, string> = {
  orchestrator: Deno.env.get('ANTHROPIC_MODEL') ?? 'claude-opus-4-8',
  utility: 'claude-haiku-4-5-20251001',
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
