// Records token + cost usage for a single model call into `usage_events`, so the
// /usage page can show spend (totals, by model / context / user, over time).
// Best-effort like logActivity — a failure here never breaks a model run. The
// `usage` object comes from the OpenRouter response (see ORUsage in openrouter.ts);
// written with the service role, so RLS (own-or-admin SELECT) governs reads only.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4'
import type { ORUsage } from './openrouter.ts'

type DB = ReturnType<typeof createClient>
type Context = 'chat' | 'webhook' | 'scheduler' | 'guardrail' | 'forge' | 'loop' | 'slack' | 'security' | 'compile' | 'summary' | 'event' | 'repository'

export async function recordUsage(
  db: DB | null,
  args: {
    context: Context
    model: string
    actorId: string | null
    agentId?: string | null
    usage: ORUsage | undefined
  },
): Promise<void> {
  if (!db || !args.usage) return
  const u = args.usage
  try {
    await db.from('usage_events').insert({
      context: args.context,
      model: args.model,
      actor_id: args.actorId,
      agent_id: args.agentId ?? null,
      prompt_tokens: u.promptTokens,
      completion_tokens: u.completionTokens,
      total_tokens: u.totalTokens,
      cost: u.cost,
      reasoning_tokens: u.reasoningTokens,
      cached_tokens: u.cachedTokens,
      detail: u.raw,
    })
  } catch {
    // best-effort — never block a run on accounting
  }
}
