import { forgeFunctionUrl, supabase } from './supabase'

// Thin client for the admin-only `forge` edge function. Like chat.ts, we fetch
// directly (rather than functions.invoke) so we can read the JSON error body the
// function returns on a non-2xx response.
async function call<T>(body: Record<string, unknown>): Promise<T> {
  const {
    data: { session },
  } = await supabase.auth.getSession()
  if (!session) throw new Error('Not authenticated')

  const res = await fetch(forgeFunctionUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: import.meta.env.VITE_SUPABASE_ANON_KEY as string,
      Authorization: `Bearer ${session.access_token}`,
    },
    body: JSON.stringify(body),
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error((json as { error?: string }).error || `Request failed (${res.status})`)
  return json as T
}

export interface GeneratedPreview {
  slug: string
  name: string
  summary: string
  input_schema: Record<string, unknown>
  code: string
  model: string
  warnings: string[]
  slug_error: string | null
}

export function generateFunction(spec: string) {
  return call<GeneratedPreview>({ action: 'generate', spec })
}

export function deployFunction(input: {
  slug: string
  name: string
  spec: string
  code: string
  input_schema: Record<string, unknown>
  model?: string | null
}) {
  return call<{ ok: true; tool_id: string }>({ action: 'deploy', ...input })
}

export function redeployFunction(id: string) {
  return call<{ ok: true }>({ action: 'redeploy', id })
}

export interface DeployResultRow {
  slug: string
  ok: boolean
  status?: number
  error?: string | null
}

/** Re-push the stored source of every forged function. */
export function redeployAllForged() {
  return call<{ ok: true; results: DeployResultRow[] }>({ action: 'redeploy_all_forged' })
}

/**
 * Redeploy the app's own core edge functions (chat/mcp/webhook/…) from the
 * source bundled into the UI at build time. The source module is heavy, so it's
 * imported lazily here to keep it out of the main bundle.
 */
export async function deployCore() {
  const { loadCoreFunctions } = await import('./functionSources')
  const functions = loadCoreFunctions()
  return call<{ ok: true; results: DeployResultRow[] }>({ action: 'deploy_core', functions })
}

export function deleteForgedFunction(id: string) {
  return call<{ ok: true }>({ action: 'delete', id })
}
