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

export function deleteForgedFunction(id: string) {
  return call<{ ok: true }>({ action: 'delete', id })
}
