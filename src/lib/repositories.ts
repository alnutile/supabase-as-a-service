// Browser-side I/O for the Repositories feature. All writes that touch GitHub
// go through the universal run-tool endpoint and the seeded builtins
// (add_repository / sync_repository), so the page, the assistant and an
// external Claude share one implementation. Pure helpers live in
// ./repositoryRef (unit-tested) and are re-exported here.
import { runToolUrl, supabase } from './supabase'
import { extractRepoId, isToolError } from './repositoryRef'

export {
  describeSync,
  extractRepoId,
  isToolError,
  matchesRepoQuery,
  parseRepoInput,
  relativeTime,
} from './repositoryRef'
export type { RepoRef, SearchableRepo, SyncState } from './repositoryRef'

export type ToolOutcome = { ok: true; result: string } | { ok: false; error: string }

async function runTool(tool: string, input: Record<string, unknown>): Promise<ToolOutcome> {
  const {
    data: { session },
  } = await supabase.auth.getSession()
  if (!session) return { ok: false, error: 'You are signed out.' }
  try {
    const res = await fetch(runToolUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: import.meta.env.VITE_SUPABASE_ANON_KEY as string,
        Authorization: `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({ tool, input }),
    })
    const body = (await res.json().catch(() => ({}))) as { result?: string; error?: string }
    if (!res.ok) return { ok: false, error: body.error ?? `Request failed (${res.status})` }
    const result = String(body.result ?? '')
    if (isToolError(result)) return { ok: false, error: result }
    return { ok: true, result }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Network error' }
  }
}

/** Connect a repository (URL or owner/name). Returns the new/existing row id when the tool reports one. */
export async function addRepository(
  repo: string,
  opts: { collection?: string | null; visibility?: 'private' | 'workspace' } = {},
): Promise<ToolOutcome & { id?: string | null }> {
  const input: Record<string, unknown> = { repo }
  if (opts.collection) input.collection = opts.collection
  if (opts.visibility) input.visibility = opts.visibility
  const out = await runTool('add_repository', input)
  return out.ok ? { ...out, id: extractRepoId(out.result) } : out
}

/** Read the repo and write/revise its summary artifact. Slow (up to ~a minute). */
export function syncRepository(repoId: string, focus?: string): Promise<ToolOutcome> {
  const input: Record<string, unknown> = { repo: repoId }
  if (focus?.trim()) input.focus = focus.trim()
  return runTool('sync_repository', input)
}
