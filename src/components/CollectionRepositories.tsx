import { Link } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import type { Database } from '../lib/database.types'

type Repo = Omit<Database['public']['Tables']['collection_repositories']['Row'], 'files'>
type Connection = { id: string; name: string; owner_id: string | null; scope: string; allowed_hosts: string[] }
const fields = 'id,collection_id,owner_id,vault_secret_id,repository,branch,path_prefix,status,commit_sha,synced_at,sync_started_at,run_id,error,file_count,omitted_count,created_at' as const
const inputClass = 'w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text'
const buttonClass = 'rounded-lg border border-border px-3 py-1.5 text-sm disabled:opacity-50 hover:bg-surface-hover'

export function CollectionRepositories({ collectionId, isOwner, shared }: { collectionId: string; isOwner: boolean; shared: boolean }) {
  const { user } = useAuth()
  const [repos, setRepos] = useState<Repo[]>([])
  const [connections, setConnections] = useState<Connection[]>([])
  const [connectionId, setConnectionId] = useState('')
  const [repository, setRepository] = useState('')
  const [branch, setBranch] = useState('')
  const [prefix, setPrefix] = useState('')
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const load = useCallback(async () => {
    const [r, c] = await Promise.all([
      supabase.from('collection_repositories').select(fields).eq('collection_id', collectionId).order('created_at'),
      supabase.from('vault_secrets').select('id,name,owner_id,scope,allowed_hosts').order('name'),
    ])
    if (r.error || c.error) setError(r.error?.message ?? c.error!.message)
    else { setRepos(r.data ?? []); setConnections((c.data ?? []).filter(secret => secret.scope === 'workspace' || secret.owner_id === user?.id)) }
    setLoading(false)
  }, [collectionId, user?.id])
  useEffect(() => { void load() }, [load])
  useEffect(() => {
    if (!repos.some(r => r.status === 'syncing' || r.status === 'pending')) return
    const timer = window.setInterval(() => { void load() }, 3000)
    return () => window.clearInterval(timer)
  }, [repos, load])

  async function act(action: string, extra: Record<string, unknown>) {
    setBusy(true); setError('')
    try {
      const { data, error: invokeError } = await supabase.functions.invoke('github-repositories', { body: { action, collection_id: collectionId, ...extra } })
      if (invokeError) {
        let message = invokeError.message
        try { message = (await invokeError.context.json()).error || message } catch { /* network failure */ }
        throw new Error(message)
      }
      if (data?.error) throw new Error(data.error)
      if (action === 'add') { setRepository(''); setBranch(''); setPrefix(''); setOpen(false) }
      await load()
    } catch (e) { setError(e instanceof Error ? e.message : 'Request failed.') }
    finally { setBusy(false) }
  }
  return <section className="mb-4 rounded-xl border border-border bg-surface p-4">
    <div className="flex items-center justify-between gap-3">
      <h2 className="font-semibold text-text">GitHub repositories</h2>
      {isOwner && <button className={buttonClass} onClick={() => setOpen(!open)}>{open ? 'Close setup' : 'Connect repository'}</button>}
    </div>
    <p className="mt-1 text-sm text-muted">Code and documentation become context when you chat with this collection. Refresh to pull the latest commit.</p>
    {error && <p role="alert" className="mt-3 text-sm text-red-600">{error}</p>}
    {loading ? <p className="mt-3 text-sm text-muted">Loading repositories…</p> : !repos.length && <p className="mt-3 text-sm text-faint">No repositories connected.</p>}
    <div className="mt-3 space-y-3">{repos.map(repo => <div key={repo.id} className="rounded-lg border border-border p-3">
      <a className="font-medium text-primary" href={`https://github.com/${repo.repository}`} target="_blank" rel="noreferrer">{repo.repository}</a>
      <p className="mt-1 text-xs text-muted">{repo.branch || 'Default branch'}{repo.path_prefix ? ` · ${repo.path_prefix}/` : ''} · {repo.status} · {repo.file_count} indexed · {repo.omitted_count} omitted</p>
      <p className="mt-1 text-xs text-muted">{repo.synced_at ? `Last refreshed ${new Date(repo.synced_at).toLocaleString()} · ${repo.commit_sha?.slice(0, 8)}` : 'No snapshot yet'}</p>
      {repo.error && <p className="mt-1 text-sm text-red-600">{repo.error} {repo.synced_at ? 'The previous snapshot is still available.' : ''}</p>}
      {isOwner && <div className="mt-2 flex flex-wrap items-center gap-2">
        <button disabled={busy || (repo.status === 'syncing' && Date.now() - Date.parse(repo.sync_started_at ?? '') < 600000)} className={buttonClass} onClick={() => act('refresh', { id: repo.id })}>Refresh</button>
        <select aria-label={`Vault secret for ${repo.repository}`} className="max-w-full rounded border border-border bg-surface p-1 text-xs" value={repo.vault_secret_id ?? ''} disabled={busy || repo.status === 'syncing'} onChange={e => act('connection', { id: repo.id, vault_secret_id: e.target.value })}>
          <option value="">Public access (no token)</option>
          {connections.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <button disabled={busy} className={buttonClass} onClick={() => act('remove', { id: repo.id })}>Disconnect</button>
      </div>}
    </div>)}</div>
    {open && isOwner && <div className="mt-4 space-y-4 border-t border-border pt-4">
      <p className="text-sm text-muted">{shared ? 'Everyone in this workspace can read imported code in this collection.' : 'Imported code follows this collection’s visibility, including if you share it later.'} GitHub credentials use the existing Secrets vault and its sharing rules.</p>
      <form className="space-y-2" onSubmit={e => { e.preventDefault(); void act('add', { repository, branch, path_prefix: prefix, vault_secret_id: connectionId }) }}>
        <label className="block text-sm">Repository<input required value={repository} onChange={e => setRepository(e.target.value)} placeholder="owner/repo or GitHub URL" className={inputClass} /></label>
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="block text-sm">Branch (optional)<input value={branch} onChange={e => setBranch(e.target.value)} placeholder="Default branch" className={inputClass} /></label>
          <label className="block text-sm">Folder (optional)<input value={prefix} onChange={e => setPrefix(e.target.value)} placeholder="e.g. services/api" className={inputClass} /></label>
        </div>
        <label className="block text-sm">Secret from vault<select value={connectionId} onChange={e => setConnectionId(e.target.value)} className={inputClass}>
          <option value="">Public repository (no token)</option>{connections.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select></label>
        <p className="text-xs text-muted">Each import includes up to 150 text files, 60 KB per file, and 1 MB total. Documentation is prioritized. Dependencies, generated output, binaries, and common secret files are excluded. Use a folder to focus a large repository. Chat selects relevant excerpts from up to 20 repositories across the selected collections; this is a partial snapshot. Repository excerpts add up to about 8,000 tokens beyond the collection meter.</p>
        <button disabled={busy || !repository.trim()} className={buttonClass}>Connect and import</button>
      </form>
      <p className="text-sm text-muted">Choose an existing secret above. To add or rotate a GitHub token, use <Link className="text-primary underline" to="/vault">Secrets</Link> (managed by workspace admins). Give the token Contents: read access and add <code>api.github.com</code> to its Allowed hosts. Private secrets are available to their owner; workspace secrets can be used by members. This importer keeps values out of chat.</p>

    </div>}
  </section>
}
