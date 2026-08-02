// Always-on prompts: the workspace-wide skills (skills.auto_apply = true) that
// teach the assistant how this workspace works. Chat has always loaded these as
// the base of its system prompt; the Slack listener now shares the same loader so
// a bound channel benefits from the same workspace knowledge/persona.
//
// Returns the concatenated instructions (builtins first, then oldest-first),
// joined with a rule, or an empty string when there are none. Callers layer their
// own fallback/role prompt around this — chat falls back to DEFAULT_SYSTEM, Slack
// keeps its channel-specific instruction.
// deno-lint-ignore no-explicit-any
export async function loadAlwaysOnPrompts(db: any): Promise<string> {
  if (!db) return ''
  try {
    const { data } = await db
      .from('skills')
      .select('instructions, is_builtin, created_at')
      .eq('auto_apply', true)
      .is('deleted_at', null)
      .order('is_builtin', { ascending: false })
      .order('created_at', { ascending: true })
    const parts = (data ?? [])
      .map((r: { instructions: string }) => (r.instructions ?? '').trim())
      .filter(Boolean)
    return parts.join('\n\n---\n\n')
  } catch {
    return ''
  }
}
