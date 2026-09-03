// Pure helpers for the Repositories page (no side-effect imports, unit-tested).
// `parseRepoInput` is the browser mirror of the edge function's parseRepoRef
// (supabase/functions/_shared/github.ts) so the quick-add box can validate what
// was pasted before a round trip; the server re-parses and is the authority.

export type RepoRef = { owner: string; name: string; fullName: string }

const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/
const NAME_RE = /^[A-Za-z0-9_.-]{1,100}$/

export function parseRepoInput(input: string): RepoRef | null {
  let s = (input ?? '').trim()
  if (!s) return null
  const ssh = s.match(/^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i)
  if (ssh) return make(ssh[1], ssh[2])
  if (/^(https?:\/\/)?(www\.)?github\.com\//i.test(s)) {
    if (!/^https?:\/\//i.test(s)) s = `https://${s}`
    let u: URL
    try {
      u = new URL(s)
    } catch {
      return null
    }
    if (u.hostname.toLowerCase().replace(/^www\./, '') !== 'github.com') return null
    const segs = u.pathname.split('/').filter(Boolean)
    if (segs.length < 2) return null
    return make(segs[0], segs[1].replace(/\.git$/i, ''))
  }
  const bare = s.match(/^([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/)
  if (bare && !s.includes(':') && !s.includes('.com/')) return make(bare[1], bare[2])
  return null
}

function make(owner: string, name: string): RepoRef | null {
  if (!OWNER_RE.test(owner) || !NAME_RE.test(name)) return null
  if (name === '.' || name === '..') return null
  return { owner, name, fullName: `${owner}/${name}` }
}

export type SearchableRepo = { full_name: string; description: string; notes: string; language: string | null; topics: string[] }

/** Case-insensitive match across the fields a person would search by. */
export function matchesRepoQuery(repo: SearchableRepo, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return (
    repo.full_name.toLowerCase().includes(q) ||
    repo.description.toLowerCase().includes(q) ||
    repo.notes.toLowerCase().includes(q) ||
    (repo.language ?? '').toLowerCase().includes(q) ||
    repo.topics.some((t) => t.toLowerCase().includes(q))
  )
}

export type SyncState = { last_sync_status: 'idle' | 'running' | 'ok' | 'error'; last_synced_at: string | null }

/** Human label + tone for the card's sync line (mirrors the server vocabulary). */
export function describeSync(state: SyncState, now = new Date()): { label: string; tone: 'muted' | 'ok' | 'busy' | 'error' } {
  if (state.last_sync_status === 'running') return { label: 'Syncing…', tone: 'busy' }
  if (state.last_sync_status === 'error') return { label: 'Last sync failed', tone: 'error' }
  if (!state.last_synced_at) return { label: 'Not synced yet', tone: 'muted' }
  return { label: `Synced ${relativeTime(state.last_synced_at, now)}`, tone: 'ok' }
}

export function relativeTime(iso: string, now = new Date()): string {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ''
  const diff = Math.max(0, now.getTime() - then)
  const min = Math.floor(diff / 60_000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min} min ago`
  const hrs = Math.floor(min / 60)
  if (hrs < 24) return `${hrs} hr${hrs === 1 ? '' : 's'} ago`
  const days = Math.floor(hrs / 24)
  if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`
  return new Date(iso).toISOString().slice(0, 10)
}

/** Pull the new row's id out of add_repository's confirmation text (best-effort). */
export function extractRepoId(toolResult: string): string | null {
  const m = toolResult.match(/\bid ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i)
  return m ? m[1] : null
}

/** A tool result that starts like an error should be shown as one. */
export function isToolError(toolResult: string): boolean {
  return /^(Could not|Sync failed|Pass a|No connected|Repositories are unavailable|Invalid)/.test(toolResult.trim())
}
