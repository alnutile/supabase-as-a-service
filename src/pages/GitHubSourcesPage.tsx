import { useCallback, useEffect, useState } from 'react'
import type { Database } from '../lib/database.types'
import { supabase, githubWebhookUrl } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import { formatDate } from '../lib/util'
import { CopyIcon, GitHubIcon, PlusIcon, TrashIcon } from '../components/icons'

type Source = Database['public']['Tables']['github_sources']['Row']
type GitHubEvent = Database['public']['Tables']['github_events']['Row']

export default function GitHubSourcesPage() {
  const { user } = useAuth()
  const [sources, setSources] = useState<Source[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    const { data } = await supabase.from('github_sources').select('*').order('updated_at', { ascending: false })
    setSources(data ?? [])
    setLoading(false)
    setSelectedId((cur) => cur ?? data?.[0]?.id ?? null)
  }, [])

  useEffect(() => {
    load()
  }, [load])

  async function create() {
    const { data } = await supabase
      .from('github_sources')
      .insert({ owner_id: user!.id, name: 'New GitHub source' })
      .select()
      .single()
    if (data) {
      setSources((s) => [data, ...s])
      setSelectedId(data.id)
    }
  }

  const selected = sources.find((s) => s.id === selectedId) ?? null

  return (
    <div className="flex h-full flex-col md:flex-row">
      {/* List */}
      <div className="flex max-h-56 shrink-0 flex-col border-b border-border bg-surface md:max-h-none md:w-72 md:border-b-0 md:border-r">
        <div className="flex items-center justify-between px-4 py-3">
          <h1 className="text-sm font-semibold text-text">GitHub sources</h1>
          <button
            onClick={create}
            className="flex items-center gap-1 rounded-lg bg-primary px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-primary-strong"
          >
            <PlusIcon className="h-3.5 w-3.5" /> New
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-2 pb-2">
          {loading ? (
            <p className="px-2 py-3 text-sm text-faint">Loading…</p>
          ) : sources.length === 0 ? (
            <p className="px-2 py-3 text-sm text-faint">No GitHub sources yet.</p>
          ) : (
            sources.map((s) => (
              <button
                key={s.id}
                onClick={() => setSelectedId(s.id)}
                className={`mb-1 flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition ${
                  s.id === selectedId ? 'bg-primary-soft text-primary' : 'text-muted hover:bg-surface-hover'
                }`}
              >
                <GitHubIcon className="h-4 w-4 shrink-0" />
                <span className="min-w-0 flex-1 truncate font-medium">{s.repo || s.name}</span>
                {!s.is_active && <span className="text-[10px] uppercase text-faint">off</span>}
              </button>
            ))
          )}
        </div>
      </div>

      {/* Detail */}
      <div className="min-w-0 flex-1 overflow-y-auto">
        {selected ? (
          <SourceDetail
            key={selected.id}
            source={selected}
            onChange={(s) => setSources((list) => list.map((x) => (x.id === s.id ? s : x)))}
            onDelete={(id) => {
              setSources((list) => list.filter((x) => x.id !== id))
              setSelectedId(null)
            }}
          />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-faint">
            <GitHubIcon className="h-10 w-10" />
            <p className="max-w-sm text-sm">
              Connect a GitHub repo to sync its docs and spec files into the knowledge base. Every
              push keeps them current, and the team's chat can search them via the assistant.
            </p>
          </div>
        )}
      </div>
    </div>
  )
}

function SourceDetail({
  source,
  onChange,
  onDelete,
}: {
  source: Source
  onChange: (s: Source) => void
  onDelete: (id: string) => void
}) {
  const [name, setName] = useState(source.name)
  const [repo, setRepo] = useState(source.repo)
  const [branch, setBranch] = useState(source.branch)
  const [globs, setGlobs] = useState((source.include_globs ?? []).join('\n'))
  const [ingestIssues, setIngestIssues] = useState(source.ingest_issues)
  const [scope, setScope] = useState(source.scope)
  const [secret, setSecret] = useState(source.secret ?? '')
  const [isActive, setIsActive] = useState(source.is_active)
  const [pat, setPat] = useState('')
  const [hasPat, setHasPat] = useState(Boolean(source.pat_secret_id))
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [copied, setCopied] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [syncMsg, setSyncMsg] = useState<string | null>(null)
  const [events, setEvents] = useState<GitHubEvent[]>([])

  const url = githubWebhookUrl(source.token)
  const globList = globs.split('\n').map((g) => g.trim()).filter(Boolean)

  const dirty =
    name !== source.name ||
    repo !== source.repo ||
    branch !== source.branch ||
    globList.join('\n') !== (source.include_globs ?? []).join('\n') ||
    ingestIssues !== source.ingest_issues ||
    scope !== source.scope ||
    secret !== (source.secret ?? '') ||
    isActive !== source.is_active

  const loadEvents = useCallback(async () => {
    const { data } = await supabase
      .from('github_events')
      .select('*')
      .eq('source_id', source.id)
      .order('created_at', { ascending: false })
      .limit(50)
    setEvents(data ?? [])
  }, [source.id])

  useEffect(() => {
    loadEvents()
    const channel = supabase
      .channel(`github_events:${source.id}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'github_events', filter: `source_id=eq.${source.id}` },
        () => loadEvents(),
      )
      .subscribe()
    return () => {
      supabase.removeChannel(channel)
    }
  }, [source.id, loadEvents])

  async function save() {
    setSaving(true)
    const { data } = await supabase
      .from('github_sources')
      .update({
        name,
        repo: repo.trim(),
        branch: branch.trim() || 'main',
        include_globs: globList,
        ingest_issues: ingestIssues,
        scope,
        secret: secret.trim() || null,
        is_active: isActive,
        updated_at: new Date().toISOString(),
      })
      .eq('id', source.id)
      .select()
      .single()
    // Persist a changed PAT via the Vault RPC (write-only; never stored on the row).
    if (pat.trim()) {
      await supabase.rpc('set_github_source_pat', { p_source_id: source.id, p_pat: pat.trim() })
      setHasPat(true)
      setPat('')
    }
    setSaving(false)
    if (data) {
      onChange(data)
      setSaved(true)
      setTimeout(() => setSaved(false), 1500)
    }
  }

  async function clearPat() {
    await supabase.rpc('set_github_source_pat', { p_source_id: source.id, p_pat: '' })
    setHasPat(false)
    setPat('')
  }

  async function copy() {
    await navigator.clipboard.writeText(url)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  async function syncNow() {
    setSyncing(true)
    setSyncMsg(null)
    const { data, error } = await supabase.functions.invoke('github-webhook', {
      body: { action: 'sync', source_id: source.id },
    })
    setSyncing(false)
    if (error) {
      setSyncMsg(`Sync failed: ${error.message}`)
    } else {
      const d = data as { staged?: number; matched?: number; remaining?: number }
      setSyncMsg(
        `Queued ${d.staged ?? 0} file(s) of ${d.matched ?? 0} matched for indexing` +
          (d.remaining ? ` — ${d.remaining} more, run sync again` : '') +
          '. They become searchable as the indexer embeds them.',
      )
      loadEvents()
    }
  }

  async function remove() {
    if (!confirm(`Delete “${source.name}”? Synced documents stay in the knowledge base.`)) return
    await supabase.from('github_sources').delete().eq('id', source.id)
    onDelete(source.id)
  }

  return (
    <div className="mx-auto max-w-2xl px-6 py-6">
      <div className="flex items-start justify-between gap-3">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="min-w-0 flex-1 rounded-lg border border-transparent px-2 py-1 text-xl font-semibold text-text outline-none hover:border-border focus:border-primary focus:ring-2 focus:ring-primary-soft"
        />
        <button
          onClick={remove}
          title="Delete source"
          className="mt-1 rounded-md p-2 text-faint hover:bg-red-50 hover:text-red-600"
        >
          <TrashIcon className="h-[18px] w-[18px]" />
        </button>
      </div>

      {/* Repo + branch */}
      <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="sm:col-span-2">
          <label className="mb-1 block text-xs font-medium text-muted">Repository (owner/name)</label>
          <input
            value={repo}
            onChange={(e) => setRepo(e.target.value)}
            placeholder="acme/handbook"
            className="w-full rounded-lg border border-border-strong px-3 py-2 font-mono text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary-soft"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-muted">Branch</label>
          <input
            value={branch}
            onChange={(e) => setBranch(e.target.value)}
            placeholder="main"
            className="w-full rounded-lg border border-border-strong px-3 py-2 font-mono text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary-soft"
          />
        </div>
      </div>

      {/* Include patterns */}
      <div className="mt-4">
        <label className="mb-1 block text-xs font-medium text-muted">
          Include patterns — one glob per line (e.g. <code className="font-mono">docs/**</code>, <code className="font-mono">**/*.md</code>)
        </label>
        <textarea
          value={globs}
          onChange={(e) => setGlobs(e.target.value)}
          rows={4}
          placeholder={'**/*.md\n**/*.mdx\ndocs/**'}
          className="w-full resize-y rounded-lg border border-border-strong px-3 py-2 font-mono text-[13px] leading-relaxed outline-none focus:border-primary focus:ring-2 focus:ring-primary-soft"
        />
        <p className="mt-1 text-xs text-muted">Only files matching a pattern are synced. Everything else (code, binaries) is ignored.</p>
      </div>

      {/* Options */}
      <div className="mt-4 flex flex-wrap items-center gap-4">
        <label className="flex items-center gap-2 text-sm text-text">
          <input
            type="checkbox"
            checked={ingestIssues}
            onChange={(e) => setIngestIssues(e.target.checked)}
            className="h-4 w-4 rounded border-border-strong text-primary focus:ring-brand-500"
          />
          Also index issues &amp; PRs
        </label>
        <label className="flex items-center gap-2 text-sm text-text">
          Visibility
          <select
            value={scope}
            onChange={(e) => setScope(e.target.value)}
            className="rounded-lg border border-border-strong px-2 py-1.5 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary-soft"
          >
            <option value="workspace">Team knowledge</option>
            <option value="private">Only me</option>
          </select>
        </label>
      </div>

      {/* Webhook endpoint + setup */}
      <div className="mt-5 rounded-xl border border-border bg-surface p-4">
        <span className="text-xs font-medium text-muted">Webhook payload URL — add this in the repo</span>
        <div className="mt-2 flex items-center gap-2">
          <code className="min-w-0 flex-1 truncate rounded-lg bg-surface-2 px-3 py-2 text-xs text-text">{url}</code>
          <button
            onClick={copy}
            className="flex shrink-0 items-center gap-1 rounded-lg border border-border-strong px-2.5 py-2 text-xs font-medium text-muted hover:bg-surface-hover"
          >
            <CopyIcon className="h-3.5 w-3.5" /> {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
        <details className="mt-2">
          <summary className="cursor-pointer text-xs text-faint">How to connect (GitHub → Settings → Webhooks)</summary>
          <ol className="mt-2 list-decimal space-y-1 pl-5 text-xs text-muted">
            <li>In the repo: <strong>Settings → Webhooks → Add webhook</strong>.</li>
            <li>Payload URL: paste the URL above. Content type: <code className="font-mono">application/json</code>.</li>
            <li>Secret: paste the secret below (recommended — it's how we verify the request is really from GitHub).</li>
            <li>Events: choose <em>Let me select individual events</em> → <strong>Pushes</strong>{ingestIssues ? ', Issues, Pull requests' : ''}.</li>
            <li>Save, then click <strong>Sync now</strong> here to index what's already there.</li>
          </ol>
        </details>
      </div>

      {/* Signing secret */}
      <div className="mt-4 rounded-xl border border-border bg-surface p-4">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-muted">Webhook secret (recommended)</span>
          <div className="flex gap-2">
            <button
              onClick={() => setSecret(crypto.randomUUID().replace(/-/g, ''))}
              className="rounded-lg border border-border-strong px-2.5 py-1 text-xs font-medium text-muted hover:bg-surface-hover"
            >
              Generate
            </button>
            {secret && (
              <button
                onClick={() => setSecret('')}
                className="rounded-lg border border-border-strong px-2.5 py-1 text-xs font-medium text-muted hover:bg-surface-hover"
              >
                Clear
              </button>
            )}
          </div>
        </div>
        <input
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
          placeholder="Leave blank to rely on the secret URL alone"
          className="mt-2 w-full rounded-lg border border-border-strong px-3 py-2 font-mono text-xs outline-none focus:border-primary focus:ring-2 focus:ring-primary-soft"
        />
        <p className="mt-1.5 text-xs text-muted">
          When set, we verify GitHub's <code className="font-mono">X-Hub-Signature-256</code> on every request and reject anything that doesn't match.
        </p>
      </div>

      {/* GitHub token (Vault) */}
      <div className="mt-4 rounded-xl border border-border bg-surface p-4">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-muted">
            GitHub token {hasPat ? <span className="ml-1 text-emerald-600">— configured</span> : <span className="ml-1 text-faint">— public repos don't need one</span>}
          </span>
          {hasPat && (
            <button
              onClick={clearPat}
              className="rounded-lg border border-border-strong px-2.5 py-1 text-xs font-medium text-muted hover:bg-surface-hover"
            >
              Clear
            </button>
          )}
        </div>
        <input
          type="password"
          value={pat}
          onChange={(e) => setPat(e.target.value)}
          placeholder={hasPat ? 'Enter a new token to replace it' : 'ghp_… (needs repo read access for private repos)'}
          className="mt-2 w-full rounded-lg border border-border-strong px-3 py-2 font-mono text-xs outline-none focus:border-primary focus:ring-2 focus:ring-primary-soft"
        />
        <p className="mt-1.5 text-xs text-muted">
          Stored encrypted in Supabase Vault — never shown again, never sent to the browser. Saved with the button below.
        </p>
      </div>

      {/* Active + Save */}
      <div className="mt-4 flex items-center justify-between">
        <label className="flex items-center gap-2 text-sm text-text">
          <input
            type="checkbox"
            checked={isActive}
            onChange={(e) => setIsActive(e.target.checked)}
            className="h-4 w-4 rounded border-border-strong text-primary focus:ring-brand-500"
          />
          Active {isActive ? '' : '(paused — events are rejected)'}
        </label>
        <div className="flex items-center gap-2">
          <button
            onClick={syncNow}
            disabled={syncing || !repo.trim() || dirty}
            title={dirty ? 'Save first' : 'Index the repo now'}
            className="rounded-lg border border-border-strong px-4 py-2 text-sm font-semibold text-muted hover:bg-surface-hover disabled:opacity-50"
          >
            {syncing ? 'Syncing…' : 'Sync now'}
          </button>
          <button
            onClick={save}
            disabled={saving || (!dirty && !pat.trim())}
            className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white hover:bg-primary-strong disabled:opacity-50"
          >
            {saving ? 'Saving…' : saved ? 'Saved!' : 'Save'}
          </button>
        </div>
      </div>
      {syncMsg && <p className="mt-2 text-xs text-muted">{syncMsg}</p>}

      {/* Events */}
      <h2 className="mt-8 text-xs font-semibold uppercase tracking-wide text-muted">Recent activity</h2>
      <div className="mt-2 space-y-2 pb-8">
        {events.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border-strong py-8 text-center text-sm text-faint">
            No events yet. Push to the repo or click Sync now.
          </p>
        ) : (
          events.map((ev) => <EventRow key={ev.id} event={ev} />)
        )}
      </div>
    </div>
  )
}

const STATUS_STYLES: Record<string, string> = {
  ok: 'bg-emerald-100 text-emerald-700',
  received: 'bg-amber-100 text-amber-700',
  skipped: 'bg-slate-100 text-slate-600',
  error: 'bg-red-100 text-red-700',
}

function EventRow({ event }: { event: GitHubEvent }) {
  return (
    <div className="rounded-xl border border-border bg-surface p-3">
      <div className="flex items-center gap-2">
        <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium uppercase ${STATUS_STYLES[event.status] ?? 'bg-slate-100 text-slate-600'}`}>
          {event.status}
        </span>
        <span className="text-[11px] font-medium text-muted">{event.event_type}</span>
        <span className="ml-auto text-xs text-faint">{formatDate(event.created_at)}</span>
      </div>
      {event.summary && <p className="mt-2 whitespace-pre-wrap text-sm text-text">{event.summary}</p>}
    </div>
  )
}
