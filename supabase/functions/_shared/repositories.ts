// Repositories (GitHub) — the I/O half of the feature (migration 0124).
//
// Two jobs:
//   1. A small GitHub REST client (`gh`) that uses the workspace token from
//      Vault when an admin has set one (Settings → GitHub; `read_github_secret`
//      is service-role-only) and falls back to anonymous requests for public
//      repositories.
//   2. The builtin handlers — add_repository / list_repositories /
//      get_repository / browse_repository / sync_repository /
//      add_repository_to_collection — shared by every agent loop via runBuiltin
//      and re-exposed by the MCP server, so internal and external Claude use one
//      code path (the memory.ts / files.ts convention).
//
// `sync_repository` is the point of the feature: it reads the repo (README,
// manifests, layout, languages, recent commits, open PRs/issues), asks the
// orchestrator model to write — or REVISE in place — the repository's single
// summary artifact, files that artifact into the repo's collections, and records
// the pass on the row (last_synced_at / last_sync_sha / sync_summary). The
// artifact is the workspace's maintained understanding of that codebase.
//
// These handlers run with the service role, so every read re-enforces the
// private/workspace rule in code (owner / workspace / admin), exactly like the
// link and to-do builtins. Everything pure (ref parsing, digest budgeting, the
// prompt, reply splitting) is in _shared/github.ts and unit-tested.
import { orComplete, systemMsg } from './openrouter.ts'
import { resolveModel } from './models.ts'
import { recordUsage } from './usage.ts'
import { collectionRefs } from './artifacts.ts'
import {
  buildRepoDigest,
  buildSyncPrompt,
  type CommitLite,
  daysAgoIso,
  formatDirListing,
  formatRepoList,
  githubErrorMessage,
  isProbablyTextPath,
  isRepoId,
  type IssueLite,
  parseRepoRef,
  parseSinceInput,
  pickKeyFiles,
  type PullLite,
  repoArtifactTitle,
  splitSyncOutput,
  syncStatusLabel,
  type TreeEntry,
  truncateText,
} from './github.ts'

// deno-lint-ignore no-explicit-any
type DB = any

const GH_API = 'https://api.github.com'
const GH_TIMEOUT_MS = 20_000
const MAX_FILE_BYTES = 400_000 // GitHub's contents API inlines files up to 1 MB; we read well under that
const BROWSE_MAX_CHARS = 30_000
const KEY_FILE_FETCH_MAX = 10
const SUMMARY_MAX_TOKENS = 6000
const SUMMARY_CONTENT_CAP = 24_000 // when get_repository inlines the artifact
const SYNC_STALE_MS = 4 * 60_000 // a 'running' older than this is treated as crashed

export interface RepoRow {
  id: string
  owner_id: string
  provider: string
  full_name: string
  url: string
  description: string
  default_branch: string
  language: string | null
  topics: string[]
  stars: number
  is_private: boolean
  metadata: Record<string, unknown>
  notes: string
  artifact_id: string | null
  last_synced_at: string | null
  last_sync_sha: string | null
  last_sync_status: string
  last_sync_error: string | null
  sync_summary: string
  visibility: string
  created_at: string
  updated_at: string
}

const REPO_COLUMNS =
  'id, owner_id, provider, full_name, url, description, default_branch, language, topics, stars, is_private, metadata, notes, artifact_id, last_synced_at, last_sync_sha, last_sync_status, last_sync_error, sync_summary, visibility, created_at, updated_at'

// ---------------------------------------------------------------------------
// GitHub client
// ---------------------------------------------------------------------------

type GhOk<T> = { ok: true; data: T; status: number }
type GhErr = { ok: false; status: number; message: string }
type GhResult<T> = GhOk<T> | GhErr

export async function githubToken(db: DB): Promise<string | null> {
  try {
    const { data } = await db.rpc('read_github_secret')
    const t = typeof data === 'string' ? data.trim() : ''
    return t || null
  } catch {
    return null
  }
}

async function gh<T>(
  path: string,
  token: string | null,
  label: string,
  opts: { raw?: boolean } = {},
): Promise<GhResult<T>> {
  const headers: Record<string, string> = {
    Accept: opts.raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'supanet-repositories',
  }
  if (token) headers.Authorization = `Bearer ${token}`
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), GH_TIMEOUT_MS)
  try {
    const res = await fetch(`${GH_API}${path}`, { headers, signal: ctrl.signal })
    if (!res.ok) {
      // A 403 with X-RateLimit-Remaining: 0 is the rate limit specifically.
      if (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0') {
        const reset = Number(res.headers.get('x-ratelimit-reset') ?? 0) * 1000
        const when = reset ? ` It resets at ${new Date(reset).toISOString()}.` : ''
        return {
          ok: false,
          status: 403,
          message: `GitHub rate limit exhausted${token ? '' : ' (anonymous requests are limited to 60/hour — an admin can add a GitHub token in Settings → GitHub)'}.${when}`,
        }
      }
      return { ok: false, status: res.status, message: githubErrorMessage(res.status, !!token, label) }
    }
    const data = (opts.raw ? await res.text() : await res.json()) as T
    return { ok: true, data, status: res.status }
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError'
    return { ok: false, status: 0, message: aborted ? `GitHub timed out for ${label}.` : `Could not reach GitHub for ${label}: ${err instanceof Error ? err.message : 'error'}` }
  } finally {
    clearTimeout(timer)
  }
}

type GhRepo = {
  full_name: string
  html_url: string
  description: string | null
  default_branch: string
  language: string | null
  topics?: string[]
  stargazers_count: number
  forks_count: number
  open_issues_count: number
  watchers_count: number
  private: boolean
  archived: boolean
  fork: boolean
  size: number
  pushed_at: string | null
  homepage: string | null
  license: { spdx_id?: string; name?: string } | null
  visibility?: string
}

function metaFromRepo(r: GhRepo) {
  return {
    full_name: r.full_name,
    url: r.html_url,
    description: r.description ?? '',
    default_branch: r.default_branch ?? '',
    language: r.language ?? null,
    topics: Array.isArray(r.topics) ? r.topics.slice(0, 20) : [],
    stars: Number(r.stargazers_count ?? 0),
    is_private: r.private === true,
    metadata: {
      forks: Number(r.forks_count ?? 0),
      open_issues: Number(r.open_issues_count ?? 0),
      watchers: Number(r.watchers_count ?? 0),
      pushed_at: r.pushed_at ?? null,
      homepage: r.homepage || null,
      license: r.license?.spdx_id && r.license.spdx_id !== 'NOASSERTION' ? r.license.spdx_id : r.license?.name ?? null,
      archived: r.archived === true,
      fork: r.fork === true,
      size_kb: Number(r.size ?? 0),
    },
  }
}

function decodeContent(b64: string): string {
  const clean = (b64 ?? '').replace(/\n/g, '')
  try {
    const bin = atob(clean)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes)
  } catch {
    return ''
  }
}

type GhContent =
  | { type: 'file'; path: string; name: string; size: number; content?: string; encoding?: string }
  | { type: 'dir' | 'symlink' | 'submodule'; path: string; name: string; size?: number }

async function fetchFileText(fullName: string, path: string, ref: string, token: string | null): Promise<string | null> {
  const q = ref ? `?ref=${encodeURIComponent(ref)}` : ''
  const res = await gh<GhContent>(`/repos/${fullName}/contents/${encodePath(path)}${q}`, token, `${fullName}:${path}`)
  if (!res.ok || Array.isArray(res.data) || res.data.type !== 'file') return null
  if ((res.data.size ?? 0) > MAX_FILE_BYTES) return null
  if (res.data.encoding === 'base64' && res.data.content) return decodeContent(res.data.content)
  return null
}

function encodePath(p: string): string {
  return p.split('/').map(encodeURIComponent).join('/')
}

function normalizePath(raw: unknown): string | null {
  const p = String(raw ?? '').trim().replace(/^\/+|\/+$/g, '')
  if (!p) return ''
  if (p.split('/').some((seg) => seg === '..' || seg === '')) return null
  return p
}

// deno-lint-ignore no-explicit-any
function commitLite(c: any): CommitLite {
  return {
    sha: String(c?.sha ?? ''),
    date: String(c?.commit?.author?.date ?? c?.commit?.committer?.date ?? ''),
    message: String(c?.commit?.message ?? ''),
    author: String(c?.author?.login ?? c?.commit?.author?.name ?? ''),
  }
}

async function fetchActivity(
  fullName: string,
  token: string | null,
  args: { since: string | null; maxCommits: number; branch?: string },
): Promise<{ commits: CommitLite[]; pulls: PullLite[]; issues: IssueLite[]; errors: string[] }> {
  const errors: string[] = []
  const per = Math.max(1, Math.min(100, args.maxCommits))
  const sinceQ = args.since ? `&since=${encodeURIComponent(args.since)}` : ''
  const shaQ = args.branch ? `&sha=${encodeURIComponent(args.branch)}` : ''
  const [c, p, i] = await Promise.all([
    // deno-lint-ignore no-explicit-any
    gh<any[]>(`/repos/${fullName}/commits?per_page=${per}${sinceQ}${shaQ}`, token, fullName),
    // deno-lint-ignore no-explicit-any
    gh<any[]>(`/repos/${fullName}/pulls?state=open&sort=updated&direction=desc&per_page=15`, token, fullName),
    // deno-lint-ignore no-explicit-any
    gh<any[]>(`/repos/${fullName}/issues?state=open&sort=updated&direction=desc&per_page=30`, token, fullName),
  ])
  const commits = c.ok ? (c.data ?? []).map(commitLite) : []
  if (!c.ok) errors.push(`commits: ${c.message}`)
  const pulls: PullLite[] = p.ok
    ? (p.data ?? []).map((x) => ({
      number: Number(x.number),
      title: String(x.title ?? ''),
      author: String(x.user?.login ?? ''),
      created_at: String(x.created_at ?? ''),
      draft: x.draft === true,
    }))
    : []
  if (!p.ok) errors.push(`pull requests: ${p.message}`)
  const issues: IssueLite[] = i.ok
    ? (i.data ?? [])
      .filter((x) => !x.pull_request) // the issues endpoint includes PRs
      .slice(0, 15)
      .map((x) => ({
        number: Number(x.number),
        title: String(x.title ?? ''),
        author: String(x.user?.login ?? ''),
        created_at: String(x.created_at ?? ''),
        // deno-lint-ignore no-explicit-any
        labels: Array.isArray(x.labels) ? x.labels.map((l: any) => String(l?.name ?? '')).filter(Boolean) : [],
      }))
    : []
  if (!i.ok) errors.push(`issues: ${i.message}`)
  return { commits, pulls, issues, errors }
}

// ---------------------------------------------------------------------------
// Shared helpers (access, lookups, logging)
// ---------------------------------------------------------------------------

async function logActivity(db: DB, type: string, summary: string, detail: Record<string, unknown>, actorId: string | null) {
  try {
    await db.from('activity_log').insert({ type, summary, detail, actor_id: actorId })
  } catch {
    // best-effort
  }
}

async function isAdmin(db: DB, userId: string): Promise<boolean> {
  const { data } = await db.from('profiles').select('is_admin').eq('id', userId).maybeSingle()
  return data?.is_admin === true
}

function canSee(row: { owner_id: string; visibility: string }, userId: string, admin: boolean): boolean {
  return row.owner_id === userId || row.visibility === 'workspace' || admin
}

/** Find a repo the caller may see by id, owner/name, or URL. */
export async function resolveRepo(db: DB, userId: string, ref: unknown): Promise<RepoRow | null> {
  const r = String(ref ?? '').trim()
  if (!r) return null
  let q = db.from('repositories').select(REPO_COLUMNS)
  if (isRepoId(r)) q = q.eq('id', r)
  else {
    const parsed = parseRepoRef(r)
    if (!parsed) return null
    q = q.ilike('full_name', parsed.fullName)
  }
  const { data } = await q.limit(1)
  const row = (data?.[0] as RepoRow | undefined) ?? null
  if (!row) return null
  if (row.owner_id === userId || row.visibility === 'workspace') return row
  return (await isAdmin(db, userId)) ? row : null
}

async function resolveCollection(
  db: DB,
  owner: string,
  ref: string,
  createIfMissing: boolean,
): Promise<{ id: string; name: string } | null> {
  const r = ref.trim()
  if (!r) return null
  const { data } = await db
    .from('collections')
    .select('id, name, owner_id, visibility')
    .or(`owner_id.eq.${owner},visibility.eq.workspace`)
  const found = (data ?? []).find(
    (c: { id: string; name: string }) => c.id === r || c.name.trim().toLowerCase() === r.toLowerCase(),
  )
  if (found) return { id: found.id, name: found.name }
  if (!createIfMissing) return null
  const { data: created } = await db
    .from('collections')
    .insert({ owner_id: owner, name: r, visibility: 'private' })
    .select('id, name')
    .single()
  return created ? { id: created.id, name: created.name } : null
}

async function fileRepoIntoCollections(db: DB, userId: string, repo: RepoRow, refs: string[]): Promise<string[]> {
  const filed: string[] = []
  for (const ref of refs) {
    const col = await resolveCollection(db, userId, ref, true)
    if (!col) continue
    const { error } = await db.from('collection_repositories').upsert(
      { collection_id: col.id, repository_id: repo.id, added_by: userId },
      { onConflict: 'collection_id,repository_id', ignoreDuplicates: true },
    )
    if (error) continue
    if (!filed.includes(col.name)) filed.push(col.name)
    // The summary artifact travels with the repo so collection chat sees it.
    if (repo.artifact_id) {
      await db.from('collection_artifacts').upsert(
        { collection_id: col.id, artifact_id: repo.artifact_id, added_by: userId },
        { onConflict: 'collection_id,artifact_id', ignoreDuplicates: true },
      )
    }
  }
  return filed
}

async function fileArtifactIntoRepoCollections(db: DB, userId: string, repoId: string, artifactId: string) {
  const { data } = await db.from('collection_repositories').select('collection_id').eq('repository_id', repoId)
  for (const row of (data ?? []) as Array<{ collection_id: string }>) {
    await db.from('collection_artifacts').upsert(
      { collection_id: row.collection_id, artifact_id: artifactId, added_by: userId },
      { onConflict: 'collection_id,artifact_id', ignoreDuplicates: true },
    )
  }
}

async function readSummaryArtifact(
  db: DB,
  repo: RepoRow,
  userId: string,
  admin: boolean,
): Promise<{ id: string; title: string; content: string; updated_at: string } | null> {
  if (!repo.artifact_id) return null
  const { data } = await db
    .from('artifacts')
    .select('id, title, content, owner_id, visibility, deleted_at, updated_at')
    .eq('id', repo.artifact_id)
    .maybeSingle()
  if (!data || data.deleted_at) return null
  if (data.owner_id !== userId && data.visibility === 'private' && !admin) return null
  return { id: data.id, title: data.title, content: data.content ?? '', updated_at: data.updated_at }
}

function repoHeader(repo: RepoRow): string {
  const m = repo.metadata ?? {}
  const facts = [
    `repository: ${repo.full_name}`,
    `url: ${repo.url}`,
    `id: ${repo.id}`,
    repo.description ? `description: ${repo.description}` : '',
    `default branch: ${repo.default_branch || '(unknown)'}`,
    repo.language ? `language: ${repo.language}` : '',
    repo.topics?.length ? `topics: ${repo.topics.join(', ')}` : '',
    `stars: ${repo.stars} · forks: ${m.forks ?? 0} · open issues: ${m.open_issues ?? 0}`,
    m.pushed_at ? `last push: ${String(m.pushed_at).slice(0, 10)}` : '',
    `github visibility: ${repo.is_private ? 'private' : 'public'} · workspace visibility: ${repo.visibility}`,
    repo.notes ? `team note: ${repo.notes}` : '',
    `sync: ${syncStatusLabel(repo)}${repo.last_sync_error ? ` (${repo.last_sync_error})` : ''}`,
    repo.artifact_id ? `summary artifact: /artifacts/${repo.artifact_id}` : 'summary artifact: none yet — run sync_repository',
  ].filter(Boolean)
  return facts.join('\n')
}

// ---------------------------------------------------------------------------
// Builtins
// ---------------------------------------------------------------------------

export async function addRepository(db: DB | null, userId: string | null, input: Record<string, unknown>): Promise<string> {
  if (!db || !userId) return 'Repositories are unavailable.'
  const parsed = parseRepoRef(input?.repo ?? input?.url)
  if (!parsed) return 'Pass a GitHub repository as a URL (https://github.com/owner/name) or owner/name.'

  const token = await githubToken(db)
  const meta = await gh<GhRepo>(`/repos/${parsed.fullName}`, token, parsed.fullName)
  if (!meta.ok) return `Could not connect ${parsed.fullName}: ${meta.message}`
  const m = metaFromRepo(meta.data)

  // Already connected? (unique per provider + lower(full_name))
  const { data: existing } = await db
    .from('repositories')
    .select(REPO_COLUMNS)
    .eq('provider', 'github')
    .ilike('full_name', m.full_name)
    .limit(1)
  const prior = (existing?.[0] as RepoRow | undefined) ?? null
  const refs = collectionRefs(input)
  if (prior) {
    const admin = await isAdmin(db, userId)
    if (!canSee(prior, userId, admin)) {
      return `${m.full_name} is already connected by another member as a private repository. Ask them to share it with the workspace.`
    }
    const filed = refs.length ? await fileRepoIntoCollections(db, userId, prior, refs) : []
    const note = filed.length ? ` Filed into collection${filed.length > 1 ? 's' : ''}: ${filed.join(', ')}.` : ''
    return `${m.full_name} is already connected (id ${prior.id}; ${syncStatusLabel(prior)}).${note}${
      prior.artifact_id ? ` Summary: /artifacts/${prior.artifact_id}.` : ' No summary yet — call sync_repository to compile one.'
    }`
  }

  const visibility = input?.visibility === 'private' ? 'private' : 'workspace'
  const notes = typeof input?.notes === 'string' ? input.notes.trim().slice(0, 2000) : ''
  const { data, error } = await db
    .from('repositories')
    .insert({ owner_id: userId, provider: 'github', ...m, visibility, notes })
    .select(REPO_COLUMNS)
    .single()
  if (error || !data) return `Could not save the repository: ${error?.message ?? 'unknown error'}`
  const row = data as RepoRow
  const filed = refs.length ? await fileRepoIntoCollections(db, userId, row, refs) : []
  await logActivity(db, 'repository.created', `Connected repository ${row.full_name}`, { id: row.id, collections: filed }, userId)
  const note = filed.length ? ` Filed into collection${filed.length > 1 ? 's' : ''}: ${filed.join(', ')}.` : ''
  return `Connected ${row.full_name} (id ${row.id}, ${row.is_private ? 'private' : 'public'} on GitHub, ${visibility} in the workspace).${note} Next: call sync_repository with repo "${row.full_name}" to read the code and compile its summary artifact.`
}

export async function listRepositories(db: DB | null, userId: string | null, input: Record<string, unknown>): Promise<string> {
  if (!db || !userId) return 'Repositories are unavailable.'
  const admin = await isAdmin(db, userId)
  let q = db.from('repositories').select(REPO_COLUMNS).order('updated_at', { ascending: false }).limit(200)
  if (!admin) q = q.or(`owner_id.eq.${userId},visibility.eq.workspace`)

  const colRef = typeof input?.collection === 'string' ? input.collection.trim() : ''
  if (colRef) {
    const col = await resolveCollection(db, userId, colRef, false)
    if (!col) return `Collection "${colRef}" not found.`
    const { data: members } = await db.from('collection_repositories').select('repository_id').eq('collection_id', col.id)
    const ids = (members ?? []).map((m: { repository_id: string }) => m.repository_id)
    if (!ids.length) return `No repositories in collection "${col.name}".`
    q = q.in('id', ids)
  }
  const { data, error } = await q
  if (error) return `Could not list repositories: ${error.message}`
  let rows = (data ?? []) as RepoRow[]
  const query = typeof input?.query === 'string' ? input.query.trim().toLowerCase() : ''
  if (query) {
    rows = rows.filter((r) =>
      r.full_name.toLowerCase().includes(query) || r.description.toLowerCase().includes(query) || r.notes.toLowerCase().includes(query)
    )
  }
  if (!rows.length) return 'No repositories connected yet. Use add_repository with a GitHub URL or owner/name.'
  return formatRepoList(rows)
}

export async function getRepository(db: DB | null, userId: string | null, input: Record<string, unknown>): Promise<string> {
  if (!db || !userId) return 'Repositories are unavailable.'
  const repo = await resolveRepo(db, userId, input?.repo)
  if (!repo) return 'No connected repository matches — pass its id, owner/name or GitHub URL (list_repositories shows them).'
  const admin = await isAdmin(db, userId)

  const since = parseSinceInput(input?.since)
  if (since === 'invalid') return '`since` must be an ISO 8601 timestamp or YYYY-MM-DD.'
  const window = since ?? repo.last_synced_at ?? daysAgoIso(30)
  const maxCommits = Math.max(1, Math.min(50, Number(input?.max_commits ?? 20) || 20))

  const token = await githubToken(db)
  const [meta, activity] = await Promise.all([
    gh<GhRepo>(`/repos/${repo.full_name}`, token, repo.full_name),
    fetchActivity(repo.full_name, token, { since: window, maxCommits, branch: repo.default_branch || undefined }),
  ])
  // Refresh the cached facts quietly (description/stars/pushed_at drift).
  if (meta.ok) {
    const m = metaFromRepo(meta.data)
    await db.from('repositories').update({
      description: m.description,
      default_branch: m.default_branch,
      language: m.language,
      topics: m.topics,
      stars: m.stars,
      is_private: m.is_private,
      metadata: { ...(repo.metadata ?? {}), ...m.metadata },
    }).eq('id', repo.id)
    Object.assign(repo, m, { metadata: { ...(repo.metadata ?? {}), ...m.metadata } })
  }

  const parts: string[] = [repoHeader(repo)]
  if (!meta.ok) parts.push(`(GitHub metadata refresh failed: ${meta.message})`)

  const includeSummary = input?.include_summary !== false
  if (includeSummary) {
    const art = await readSummaryArtifact(db, repo, userId, admin)
    if (art) {
      parts.push(
        `## Summary artifact (${art.title}, updated ${art.updated_at.slice(0, 10)}, /artifacts/${art.id})\n` +
          truncateText(art.content, SUMMARY_CONTENT_CAP, '…(summary truncated — open the artifact for the rest)'),
      )
    } else if (repo.artifact_id) {
      parts.push('## Summary artifact\n(The summary artifact is archived or not visible to you — run sync_repository to rebuild it.)')
    } else {
      parts.push('## Summary artifact\n(none yet — run sync_repository to read the code and compile one)')
    }
  }

  const sinceLabel = window.slice(0, 10)
  parts.push(`## Activity on GitHub since ${sinceLabel}${since ? '' : repo.last_synced_at ? ' (the last sync)' : ' (last 30 days)'}`)
  parts.push(`### Commits\n${activity.commits.length ? activity.commits.map((c) => `- ${c.date.slice(0, 10)} ${c.sha.slice(0, 7)} ${c.message.split('\n')[0].slice(0, 120)}${c.author ? ` (${c.author})` : ''}`).join('\n') : '(no commits in this window)'}`)
  parts.push(`### Open pull requests\n${activity.pulls.length ? activity.pulls.map((p) => `- #${p.number} ${p.title}${p.draft ? ' [draft]' : ''} (${p.author}, opened ${p.created_at.slice(0, 10)})`).join('\n') : '(none)'}`)
  parts.push(`### Open issues\n${activity.issues.length ? activity.issues.map((i) => `- #${i.number} ${i.title}${i.labels?.length ? ` [${i.labels.slice(0, 4).join(', ')}]` : ''} (${i.author}, opened ${i.created_at.slice(0, 10)})`).join('\n') : '(none)'}`)
  if (activity.errors.length) parts.push(`(Some GitHub reads failed: ${activity.errors.join('; ')})`)
  if (activity.commits.length && repo.last_synced_at && !since) {
    parts.push(`The summary may be behind — ${activity.commits.length} commit(s) landed since the last sync. Offer sync_repository to refresh it.`)
  }
  return parts.join('\n\n')
}

export async function browseRepository(db: DB | null, userId: string | null, input: Record<string, unknown>): Promise<string> {
  if (!db || !userId) return 'Repositories are unavailable.'
  const repo = await resolveRepo(db, userId, input?.repo)
  if (!repo) return 'No connected repository matches — pass its id, owner/name or GitHub URL.'
  const path = normalizePath(input?.path)
  if (path === null) return 'Invalid path.'
  const ref = typeof input?.ref === 'string' && input.ref.trim() ? input.ref.trim() : repo.default_branch
  const token = await githubToken(db)
  const q = ref ? `?ref=${encodeURIComponent(ref)}` : ''
  const res = await gh<GhContent | GhContent[]>(`/repos/${repo.full_name}/contents/${encodePath(path)}${q}`, token, `${repo.full_name}/${path || ''}`)
  if (!res.ok) return res.message

  if (Array.isArray(res.data)) {
    const listing = formatDirListing(path, res.data.map((e) => ({ name: e.name, type: e.type, size: e.size })))
    return `${repo.full_name}${ref ? `@${ref}` : ''} — ${path || '/'} (${res.data.length} entr${res.data.length === 1 ? 'y' : 'ies'})\n${listing}`
  }
  const item = res.data
  if (item.type !== 'file') return `${path} is a ${item.type}, not a file or directory.`
  if (!isProbablyTextPath(item.path)) return `${item.path} is a binary file (${item.size} bytes) — not shown.`
  if ((item.size ?? 0) > MAX_FILE_BYTES) return `${item.path} is too large to inline (${item.size} bytes).`
  const text = item.content ? decodeContent(item.content) : ''
  if (!text) return `${item.path} is empty or could not be decoded.`
  return `${repo.full_name}${ref ? `@${ref}` : ''} — ${item.path} (${item.size} bytes)\n\n${truncateText(text, BROWSE_MAX_CHARS, '…(file truncated)')}`
}

export async function syncRepository(db: DB | null, userId: string | null, input: Record<string, unknown>): Promise<string> {
  if (!db || !userId) return 'Repositories are unavailable.'
  const repo = await resolveRepo(db, userId, input?.repo)
  if (!repo) return 'No connected repository matches — pass its id, owner/name or GitHub URL (add_repository connects a new one).'

  if (repo.last_sync_status === 'running' && Date.now() - new Date(repo.updated_at).getTime() < SYNC_STALE_MS) {
    return `${repo.full_name} is already syncing — wait for it to finish (the repositories page updates live).`
  }
  const focus = typeof input?.focus === 'string' ? input.focus.trim().slice(0, 500) : ''
  const maxCommits = Math.max(5, Math.min(100, Number(input?.max_commits ?? 30) || 30))

  await db.from('repositories').update({ last_sync_status: 'running', last_sync_error: null }).eq('id', repo.id)

  const fail = async (message: string) => {
    await db.from('repositories').update({ last_sync_status: 'error', last_sync_error: message.slice(0, 1000) }).eq('id', repo.id)
    await logActivity(db, 'repository.sync_failed', `Sync failed for ${repo.full_name}`, { id: repo.id, error: message }, userId)
    return `Sync failed for ${repo.full_name}: ${message}`
  }

  try {
    const token = await githubToken(db)
    const meta = await gh<GhRepo>(`/repos/${repo.full_name}`, token, repo.full_name)
    if (!meta.ok) return await fail(meta.message)
    const m = metaFromRepo(meta.data)
    const branch = m.default_branch || repo.default_branch || 'main'

    const [head, treeRes, readmeRes, langRes, activity] = await Promise.all([
      gh<{ sha: string }>(`/repos/${repo.full_name}/commits/${encodeURIComponent(branch)}`, token, repo.full_name),
      gh<{ tree: TreeEntry[]; truncated?: boolean }>(`/repos/${repo.full_name}/git/trees/${encodeURIComponent(branch)}?recursive=1`, token, repo.full_name),
      gh<string>(`/repos/${repo.full_name}/readme`, token, repo.full_name, { raw: true }),
      gh<Record<string, number>>(`/repos/${repo.full_name}/languages`, token, repo.full_name),
      fetchActivity(repo.full_name, token, { since: repo.last_synced_at ?? daysAgoIso(90), maxCommits, branch }),
    ])
    const tree = treeRes.ok ? (treeRes.data.tree ?? []) : []
    const keyPaths = pickKeyFiles(tree, KEY_FILE_FETCH_MAX)
    const keyFiles: Array<{ path: string; content: string }> = []
    for (const p of keyPaths) {
      if (!isProbablyTextPath(p)) continue
      const content = await fetchFileText(repo.full_name, p, branch, token)
      if (content) keyFiles.push({ path: p, content })
    }

    const digest = buildRepoDigest({
      fullName: m.full_name,
      description: m.description,
      defaultBranch: branch,
      language: m.language,
      topics: m.topics,
      homepage: m.metadata.homepage,
      license: m.metadata.license,
      languages: langRes.ok ? langRes.data : undefined,
      readme: readmeRes.ok ? readmeRes.data : '',
      tree,
      treeTruncated: treeRes.ok ? treeRes.data.truncated === true : false,
      keyFiles,
      commits: activity.commits,
      pulls: activity.pulls,
      issues: activity.issues,
    })

    // Existing summary (revise in place) — read regardless of visibility: the
    // caller already proved collaborate rights on the repo row.
    let existing: { id: string; content: string } | null = null
    if (repo.artifact_id) {
      const { data: art } = await db.from('artifacts').select('id, content, deleted_at').eq('id', repo.artifact_id).maybeSingle()
      if (art && !art.deleted_at) existing = { id: art.id, content: art.content ?? '' }
    }

    const prompt = buildSyncPrompt({
      fullName: m.full_name,
      url: m.url,
      digest,
      existingSummary: existing?.content ?? null,
      focus,
      sinceLabel: repo.last_synced_at ? repo.last_synced_at.slice(0, 10) : undefined,
      notes: repo.notes,
    })
    const model = await resolveModel(db, 'orchestrator')
    const out = await orComplete({
      model,
      messages: [systemMsg(prompt.system), { role: 'user', content: prompt.user }],
      maxTokens: SUMMARY_MAX_TOKENS,
    })
    await recordUsage(db, { context: 'repository', model, actorId: userId, usage: out.usage })
    const { summary, brief } = splitSyncOutput(out.content)
    if (summary.trim().length < 200) return await fail('the model returned an empty or too-short summary')

    // Write the artifact: revise in place, or create it owned by the repo's
    // owner. Visibility follows the repo: workspace → unlisted (members can
    // read it over RLS), private → private.
    let artifactId = existing?.id ?? null
    const artifactVisibility = repo.visibility === 'workspace' ? 'unlisted' : 'private'
    if (artifactId) {
      const { error } = await db.from('artifacts').update({ content: summary, title: repoArtifactTitle(m.full_name) }).eq('id', artifactId)
      if (error) return await fail(`could not update the summary artifact: ${error.message}`)
    } else {
      const { data: created, error } = await db
        .from('artifacts')
        .insert({ owner_id: repo.owner_id, title: repoArtifactTitle(m.full_name), type: 'markdown', content: summary, visibility: artifactVisibility })
        .select('id')
        .single()
      if (error || !created) return await fail(`could not create the summary artifact: ${error?.message ?? 'unknown error'}`)
      artifactId = created.id as string
    }
    await fileArtifactIntoRepoCollections(db, userId, repo.id, artifactId)

    const now = new Date().toISOString()
    const { error: upErr } = await db
      .from('repositories')
      .update({
        ...m,
        metadata: { ...(repo.metadata ?? {}), ...m.metadata },
        artifact_id: artifactId,
        last_synced_at: now,
        last_sync_sha: head.ok ? head.data.sha : activity.commits[0]?.sha ?? repo.last_sync_sha,
        last_sync_status: 'ok',
        last_sync_error: null,
        sync_summary: brief.slice(0, 4000),
      })
      .eq('id', repo.id)
    if (upErr) return await fail(`could not record the sync: ${upErr.message}`)

    await logActivity(
      db,
      'repository.synced',
      `Synced repository ${m.full_name}`,
      { id: repo.id, artifact_id: artifactId, commits: activity.commits.length, revised: !!existing, focus: focus || undefined },
      userId,
    )
    const readErrors = [
      !treeRes.ok ? `tree: ${treeRes.message}` : '',
      !readmeRes.ok && readmeRes.status !== 404 ? `readme: ${readmeRes.message}` : '',
      ...activity.errors,
    ].filter(Boolean)
    return [
      `${existing ? 'Revised' : 'Compiled'} the summary for ${m.full_name} — /artifacts/${artifactId} (${keyFiles.length} key file${keyFiles.length === 1 ? '' : 's'} + README, ${activity.commits.length} commit${activity.commits.length === 1 ? '' : 's'}, ${activity.pulls.length} open PR${activity.pulls.length === 1 ? '' : 's'}, ${activity.issues.length} open issue${activity.issues.length === 1 ? '' : 's'} read).`,
      '',
      'Change brief:',
      brief,
      readErrors.length ? `\n(Partial read — ${readErrors.join('; ')})` : '',
    ].join('\n').trim()
  } catch (err) {
    return await fail(err instanceof Error ? err.message : 'unexpected error')
  } finally {
    // Never leave a row stuck in 'running' — a thrown error above already set
    // 'error'; a success set 'ok'. This only catches a code path that returned
    // early without touching the status.
    const { data: check } = await db.from('repositories').select('last_sync_status').eq('id', repo.id).maybeSingle()
    if (check?.last_sync_status === 'running') {
      await db.from('repositories').update({ last_sync_status: 'error', last_sync_error: 'sync ended unexpectedly' }).eq('id', repo.id)
    }
  }
}

export async function addRepositoryToCollection(db: DB | null, userId: string | null, input: Record<string, unknown>): Promise<string> {
  if (!db || !userId) return 'Repositories are unavailable.'
  const repo = await resolveRepo(db, userId, input?.repo)
  if (!repo) return 'No connected repository matches — pass its id, owner/name or GitHub URL.'
  const ref = String(input?.collection ?? '').trim()
  if (!ref) return 'Pass a collection (name or id).'
  const filed = await fileRepoIntoCollections(db, userId, repo, [ref])
  if (!filed.length) return `Could not file ${repo.full_name} into "${ref}".`
  return `Added ${repo.full_name} to collection "${filed[0]}"${repo.artifact_id ? ' (its summary artifact too)' : ''}.`
}
