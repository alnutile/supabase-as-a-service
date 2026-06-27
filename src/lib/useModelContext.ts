import { useEffect, useState } from 'react'
import { supabase } from './supabase'
import { fetchModelContext, type ModelContext } from './tokens'

// Resolve the context window of the model that actually powers chat right now —
// the `orchestrator` profile in `model_profiles` (admin-managed in Settings →
// Models) → its OpenRouter slug → the live catalog. So when an admin re-points
// the model, the meters reflect the new window without any other change.
export function useOrchestratorContext(): ModelContext | null {
  const [ctx, setCtx] = useState<ModelContext | null>(null)

  useEffect(() => {
    let active = true
    async function run() {
      const { data } = await supabase
        .from('model_profiles')
        .select('model')
        .eq('key', 'orchestrator')
        .maybeSingle()
      const slug = data?.model ?? 'anthropic/claude-sonnet-4.5'
      const resolved = await fetchModelContext(slug)
      if (active) setCtx(resolved)
    }
    run()
    return () => {
      active = false
    }
  }, [])

  return ctx
}
