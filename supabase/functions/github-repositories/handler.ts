import { hostMatches } from '../_shared/http_tool.ts'
import { decodeBlob, normalizePrefix, parseRepository, selectFiles, type RepoFile, type TreeEntry } from '../_shared/github_repositories.ts'

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' }
const respond = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })
// Supabase query builder; keeping the dependency out of this module lets the
// authentication and snapshot transitions run in isolated tests.
// deno-lint-ignore no-explicit-any
type DB = any

export async function githubSecret(client: DB, id: string, userId: string) {
  const { data: secret, error } = await client.from('vault_secrets')
    .select('name,owner_id,scope,allowed_hosts').eq('id', id).maybeSingle()
  if (error || !secret || (secret.owner_id !== userId && secret.scope !== 'workspace')) {
    throw new Error('Secret not found or not shared with you.')
  }
  if (!hostMatches('api.github.com', secret.allowed_hosts ?? [])) {
    throw new Error('Add api.github.com to this secret’s Allowed hosts in Secrets.')
  }
  return secret
}

export async function githubGet(path: string, token: string | null) {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    redirect: 'error', signal: AbortSignal.timeout(20000),
  })
  if (!response.ok) throw new Error(response.status === 401 ? 'GitHub token is invalid or expired.' : response.status === 403 || response.status === 429 ? 'GitHub denied access or rate limited this request. Check token permissions and retry later.' : response.status === 404 ? 'Repository or branch not found. Check the name and token access.' : `GitHub request failed (${response.status}).`)
  return response.json()
}

export async function syncRepository(client: DB, row: Record<string, any>, runId: string) {
  try {
    let token: string | null = null
    if (row.vault_secret_id) {
      const secret = await githubSecret(client, row.vault_secret_id, row.owner_id)
      const result = await client.rpc('read_vault_secret', { p_name: secret.name, p_user_id: row.owner_id })
      if (result.error || !result.data) throw new Error('Secret unavailable. Check its scope in Secrets.')
      token = result.data
    }
    const base = `/repos/${row.repository}`
    const meta = await githubGet(base, token)
    const branch = row.branch || meta.default_branch
    const commit = await githubGet(`${base}/commits/${encodeURIComponent(branch)}`, token)
    const tree = await githubGet(`${base}/git/trees/${commit.commit.tree.sha}?recursive=1`, token)
    if (tree.truncated) throw new Error('GitHub returned an incomplete repository tree. This repository is too large for this importer.')
    const selected = selectFiles(tree.tree as TreeEntry[], row.path_prefix)
    if (!selected.length && !row.synced_at) throw new Error('No supported source files found. Check the folder path and import limits.')
    const previous = new Map<string, RepoFile>((row.files ?? []).map((f: RepoFile) => [f.path, f]))
    const files: RepoFile[] = []
    for (let i = 0; i < selected.length; i += 6) {
      const batch = await Promise.all(selected.slice(i, i + 6).map(async entry => {
        const cached = previous.get(entry.path)
        if (cached?.sha === entry.sha) return cached
        const blob = await githubGet(`${base}/git/blobs/${entry.sha}`, token)
        if (blob.encoding !== 'base64') throw new Error('GitHub returned an unsupported file encoding.')
        const content = decodeBlob(blob.content)
        return content === null ? null : { path: entry.path, sha: entry.sha, content }
      }))
      files.push(...batch.filter((f): f is RepoFile => f !== null))
    }
    const omitted = (tree.tree as TreeEntry[]).filter(f => f.type === 'blob' && (!row.path_prefix || f.path.startsWith(row.path_prefix + '/'))).length - files.length
    const result = await client.from('collection_repositories').update({ files, file_count: files.length, omitted_count: omitted, branch, commit_sha: commit.sha, synced_at: new Date().toISOString(), status: 'ready', error: null, run_id: null }).eq('id', row.id).eq('run_id', runId)
    if (result.error) throw new Error('Could not save the repository snapshot. Retry refresh.')
  } catch (error) {
    // Errors never contain GitHub response bodies, request headers or tokens.
    const message = error instanceof Error ? error.message : 'Repository refresh failed.'
    await client.from('collection_repositories').update({ status: 'error', error: message.slice(0, 300), run_id: null }).eq('id', row.id).eq('run_id', runId)
  }
}

export async function handleRepositoryRequest(req: Request, client: DB) {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS })
  if (req.method !== 'POST') return respond({ error: 'Use POST.' }, 405)
  const { data: { user }, error } = await client.auth.getUser((req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, ''))
  if (error || !user) return respond({ error: 'Authentication required.' }, 401)
  try {
    const body = await req.json()
    const { data: collection } = await client.from('collections').select('id,owner_id').eq('id', body.collection_id).maybeSingle()
    // Only the collection owner can expose private repository code to this collection.
    if (!collection || collection.owner_id !== user.id) return respond({ error: 'Only the collection owner can manage repositories.' }, 403)
    if (!['add', 'refresh', 'remove', 'connection'].includes(body.action)) return respond({ error: 'Unknown action.' }, 400)
    let row
    if (body.action === 'add') {
      const repository = parseRepository(String(body.repository ?? ''))
      const prefix = normalizePrefix(String(body.path_prefix ?? ''))
      const branch = String(body.branch ?? '').trim()
      if (branch.length > 200 || /[\x00-\x1f]/.test(branch)) throw new Error('Invalid branch.')
      if (body.vault_secret_id) await githubSecret(client, body.vault_secret_id, user.id)
      const inserted = await client.from('collection_repositories').insert({ collection_id: collection.id, owner_id: user.id, vault_secret_id: body.vault_secret_id || null, repository, branch, path_prefix: prefix }).select().single()
      if (inserted.error) return respond({ error: inserted.error.code === '23505' ? 'This repository and folder are already connected.' : 'Could not connect repository.' }, 400)
      row = inserted.data
    } else {
      const result = await client.from('collection_repositories').select('*').eq('id', body.id).eq('collection_id', collection.id).eq('owner_id', user.id).maybeSingle()
      row = result.data
      if (!row) return respond({ error: 'Repository not found.' }, 404)
    }
    if (body.action === 'remove') {
      const removed = await client.from('collection_repositories').delete().eq('id', row.id)
      if (removed.error) throw new Error('Could not remove repository.')
      return respond({ ok: true })
    }
    if (body.action === 'connection') {
      if (body.vault_secret_id) await githubSecret(client, body.vault_secret_id, user.id)
      row.vault_secret_id = body.vault_secret_id || null
    }
    const runId = crypto.randomUUID()
    // Atomic lease prevents overlapping refreshes; abandoned workers can be retried.
    const lease = await client.from('collection_repositories').update({ ...(body.action === 'connection' ? { vault_secret_id: row.vault_secret_id } : {}), status: 'syncing', run_id: runId, sync_started_at: new Date().toISOString(), error: null })
      .eq('id', row.id).or(`status.neq.syncing,sync_started_at.lt.${new Date(Date.now() - 10 * 60_000).toISOString()}`).select('id').maybeSingle()
    if (lease.error) throw new Error('Could not start refresh.')
    if (!lease.data) return respond({ error: 'A refresh is already running. Retry in ten minutes if it was interrupted.' }, 409)
    const work = syncRepository(client, row, runId)
    // Supabase keeps the worker alive after this response.
    const runtime = (globalThis as unknown as { EdgeRuntime?: { waitUntil: (p: Promise<void>) => void } }).EdgeRuntime
    if (runtime) runtime.waitUntil(work)
    else await work
    return respond({ id: row.id, status: 'syncing' }, 202)
  } catch (error) {
    return respond({ error: error instanceof Error ? error.message : 'Invalid request.' }, 400)
  }
}
