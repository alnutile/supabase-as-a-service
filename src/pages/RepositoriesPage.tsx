// Assets → Repositories: connect the company's GitHub repositories and keep one
// maintained summary artifact per repo — the workspace's memory of what each
// product is, how it is built and what the team is working on (migration 0124).
//
// Adding goes through the `add_repository` builtin (run-tool) so the metadata
// fetch + the GitHub token stay server-side; "Sync" runs `sync_repository`,
// which reads the repo and writes/revises the summary artifact. The page is
// realtime-subscribed to `repositories`, so a sync started here, from chat, or
// by a scheduled agent flips its status live for everyone looking.
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import type { Database } from '../lib/database.types'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import { addRepository, describeSync, matchesRepoQuery, parseRepoInput, relativeTime, syncRepository } from '../lib/repositories'
import { AddToCollectionBar } from '../components/AddToCollectionBar'
import { CollectionPicker } from '../components/CollectionPicker'
import {
  ArtifactIcon,
  ChatIcon,
  CheckIcon,
  CloseIcon,
  CollectionIcon,
  LockIcon,
  LoopIcon,
  PencilIcon,
  PlusIcon,
  RepoIcon,
  SearchIcon,
  TrashIcon,
} from '../components/icons'

// Stable identity for "nothing picked" — the picker memoizes on `selected`.
const EMPTY_SELECTION: Set<string> = new Set()

type Repo = Database['public']['Tables']['repositories']['Row']
type Collection = Database['public']['Tables']['collections']['Row']

export default function RepositoriesPage() {
  const { user } = useAuth()
  const [repos, setRepos] = useState<Repo[]>([])
  const [collections, setCollections] = useState<Collection[]>([])
  const [members, setMembers] = useState<Record<string, Set<string>>>({}) // collection_id -> repo ids
  const [loading, setLoading] = useState(true)
  const [githubConfigured, setGithubConfigured] = useState<boolean | null>(null)
  const [isAdmin, setIsAdmin] = useState(false)

  const [quickRef, setQuickRef] = useState('')
  const [adding, setAdding] = useState(false)
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)
  const [syncingIds, setSyncingIds] = useState<Set<string>>(new Set())
  const [activeCollection, setActiveCollection] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [editing, setEditing] = useState<Repo | null>(null)

  const load = useCallback(async () => {
    const [rRes, cRes, mRes, gh] = await Promise.all([
      supabase.from('repositories').select('*').order('updated_at', { ascending: false }),
      supabase.from('collections').select('*').order('pinned', { ascending: false }).order('name', { ascending: true }),
      supabase.from('collection_repositories').select('collection_id, repository_id'),
      supabase.rpc('github_is_configured'),
    ])
    setRepos(rRes.data ?? [])
    setCollections(cRes.data ?? [])
    const map: Record<string, Set<string>> = {}
    for (const row of mRes.data ?? []) {
      const set = (map[row.collection_id] ??= new Set())
      set.add(row.repository_id)
    }
    setMembers(map)
    setGithubConfigured(gh.data === true)
    setLoading(false)
  }, [])

  useEffect(() => {
    load()
  }, [load])

  useEffect(() => {
    if (!user) return
    supabase
      .from('profiles')
      .select('is_admin')
      .eq('id', user.id)
      .maybeSingle()
      .then(({ data }) => setIsAdmin(data?.is_admin === true))
  }, [user])

  // Live: a sync finishing anywhere (this tab, chat, a scheduled agent) lands here.
  useEffect(() => {
    const channel = supabase
      .channel('repositories-page')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'repositories' }, (payload) => {
        if (payload.eventType === 'DELETE') {
          const id = (payload.old as { id?: string }).id
          if (id) setRepos((prev) => prev.filter((r) => r.id !== id))
          return
        }
        const row = payload.new as Repo
        setRepos((prev) => {
          const idx = prev.findIndex((r) => r.id === row.id)
          if (idx < 0) return [row, ...prev]
          const next = [...prev]
          next[idx] = row
          return next
        })
        if (row.last_sync_status !== 'running') {
          setSyncingIds((prev) => {
            if (!prev.has(row.id)) return prev
            const next = new Set(prev)
            next.delete(row.id)
            return next
          })
        }
      })
      .subscribe()
    return () => {
      supabase.removeChannel(channel)
    }
  }, [])

  const selectedIds = useMemo(() => [...selected], [selected])

  const collectionCounts = useMemo(() => {
    const out: Record<string, number> = {}
    for (const c of collections) out[c.id] = (members[c.id] ?? new Set()).size
    return out
  }, [collections, members])

  const visible = useMemo(() => {
    let list = repos
    if (activeCollection) {
      const set = members[activeCollection] ?? new Set()
      list = list.filter((r) => set.has(r.id))
    }
    const q = search.trim()
    if (q) list = list.filter((r) => matchesRepoQuery(r, q))
    return list
  }, [repos, members, activeCollection, search])

  // --- mutations -----------------------------------------------------------

  function markSyncing(id: string, on: boolean) {
    setSyncingIds((prev) => {
      const next = new Set(prev)
      if (on) next.add(id)
      else next.delete(id)
      return next
    })
  }

  async function runSync(id: string, focus?: string) {
    if (syncingIds.has(id)) return
    markSyncing(id, true)
    setRepos((prev) => prev.map((r) => (r.id === id ? { ...r, last_sync_status: 'running' } : r)))
    const out = await syncRepository(id, focus)
    markSyncing(id, false)
    if (!out.ok) {
      setNotice({ tone: 'error', text: out.error })
      await load()
      return
    }
    setNotice({ tone: 'ok', text: out.result.split('\n')[0] })
    await load()
  }

  // Connect via the builtin (server fetches metadata with the workspace token),
  // then kick off the first sync so the summary exists without a second click.
  async function addQuick() {
    const parsed = parseRepoInput(quickRef)
    if (!parsed || adding) return
    setAdding(true)
    setNotice(null)
    const out = await addRepository(parsed.fullName, { collection: activeCollection })
    setAdding(false)
    if (!out.ok) {
      setNotice({ tone: 'error', text: out.error })
      return
    }
    setQuickRef('')
    await load()
    let id = out.id ?? null
    if (!id) {
      const { data } = await supabase.from('repositories').select('id').ilike('full_name', parsed.fullName).maybeSingle()
      id = data?.id ?? null
    }
    if (id && /^Connected /.test(out.result)) {
      setNotice({ tone: 'ok', text: `Connected ${parsed.fullName} — compiling its summary…` })
      runSync(id)
    } else {
      setNotice({ tone: 'ok', text: out.result })
    }
  }

  async function patchRepo(id: string, patch: Partial<Repo>) {
    setRepos((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)))
    await supabase.from('repositories').update(patch).eq('id', id)
  }

  // Visibility follows through to the summary artifact (workspace → unlisted so
  // members can read it over RLS; private → private). Best-effort: only the
  // artifact's owner can update it.
  async function toggleVisibility(repo: Repo) {
    const next = repo.visibility === 'workspace' ? 'private' : 'workspace'
    await patchRepo(repo.id, { visibility: next })
    if (repo.artifact_id) {
      await supabase.from('artifacts').update({ visibility: next === 'workspace' ? 'unlisted' : 'private' }).eq('id', repo.artifact_id)
    }
  }

  async function deleteRepo(repo: Repo) {
    if (!confirm(`Disconnect ${repo.full_name}? Its summary artifact stays in Artifacts.`)) return
    setRepos((prev) => prev.filter((r) => r.id !== repo.id))
    setSelected((prev) => {
      const next = new Set(prev)
      next.delete(repo.id)
      return next
    })
    await supabase.from('repositories').delete().eq('id', repo.id)
  }

  async function removeFromActive(repoId: string) {
    if (!activeCollection) return
    await supabase.from('collection_repositories').delete().eq('collection_id', activeCollection).eq('repository_id', repoId)
    setMembers((prev) => {
      const set = new Set(prev[activeCollection] ?? [])
      set.delete(repoId)
      return { ...prev, [activeCollection]: set }
    })
  }

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const canAdd = !!parseRepoInput(quickRef)

  // --- render --------------------------------------------------------------

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-6xl px-6 py-8">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight text-text">
            <RepoIcon className="h-6 w-6 text-muted" /> Repositories
          </h1>
          <p className="mt-1 text-sm text-muted">
            Connect the GitHub repositories behind your products. Each one gets a maintained summary artifact — what it is,
            how it is built, what the team is working on — that chat, agents and collections can draw on. Re-sync any time
            to fold in the latest changes.
          </p>
        </div>

        {/* Token status — public repos work without one; private ones need it. */}
        {githubConfigured === false && (
          <div className="mt-4 flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface-2 px-3 py-2 text-xs text-muted">
            <LockIcon className="h-3.5 w-3.5 shrink-0" />
            <span>
              No GitHub token is configured — public repositories work (with GitHub's anonymous rate limit); private ones need a
              token.
            </span>
            {isAdmin ? (
              <Link to="/settings/github" className="font-semibold text-primary hover:underline">
                Add one in Settings → GitHub
              </Link>
            ) : (
              <span>Ask an admin to add one in Settings → GitHub.</span>
            )}
          </div>
        )}

        {/* Quick add */}
        <div className="mt-5 flex items-center gap-2">
          <input
            value={quickRef}
            onChange={(e) => setQuickRef(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                addQuick()
              }
            }}
            placeholder="Paste a GitHub URL or owner/name and press Enter…"
            className="flex-1 rounded-lg border border-border-strong bg-surface px-3 py-2.5 text-sm outline-none focus:border-primary focus:ring-1 focus:ring-primary-soft"
          />
          <button
            onClick={addQuick}
            disabled={!canAdd || adding}
            className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2.5 text-sm font-semibold text-white transition hover:bg-primary-strong disabled:opacity-50"
          >
            <PlusIcon className="h-4 w-4" /> {adding ? 'Connecting…' : 'Connect'}
          </button>
        </div>
        {quickRef.trim() && !canAdd && (
          <p className="mt-1 text-xs text-faint">That doesn't look like a GitHub repository — try https://github.com/owner/name or owner/name.</p>
        )}

        {notice && (
          <div
            className={`mt-3 flex items-start justify-between gap-3 rounded-lg border px-3 py-2 text-xs ${
              notice.tone === 'error' ? 'border-red-200 bg-red-50 text-red-700' : 'border-border bg-surface-2 text-muted'
            }`}
          >
            <span className="whitespace-pre-wrap">{notice.text}</span>
            <button onClick={() => setNotice(null)} aria-label="Dismiss" className="shrink-0 rounded-md p-0.5 hover:bg-surface-hover">
              <CloseIcon className="h-3.5 w-3.5" />
            </button>
          </div>
        )}

        {/* Quick search */}
        <div className="relative mt-3">
          <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-faint" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search repositories…"
            className="w-full rounded-lg border border-border bg-surface py-2 pl-9 pr-9 text-sm outline-none focus:border-primary focus:ring-1 focus:ring-primary-soft"
          />
          {search && (
            <button
              onClick={() => setSearch('')}
              aria-label="Clear search"
              className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded-md p-1 text-faint hover:bg-surface-hover hover:text-muted"
            >
              <CloseIcon className="h-4 w-4" />
            </button>
          )}
        </div>

        <div className="mt-5 flex flex-wrap items-center gap-2">
          <CollectionPicker
            collections={collections}
            selected={activeCollection ? new Set([activeCollection]) : EMPTY_SELECTION}
            onChange={(next) => setActiveCollection([...next][0] ?? null)}
            counts={collectionCounts}
            mode="single"
            totalLabel={String(repos.length)}
          />
        </div>

        <div className="mt-5">
          {loading ? (
            <p className="text-sm text-muted">Loading…</p>
          ) : visible.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border py-16 text-center text-sm text-muted">
              {search.trim()
                ? `No repositories match “${search.trim()}”.`
                : activeCollection
                  ? 'No repositories in this collection yet.'
                  : 'Nothing connected yet — paste a GitHub URL above to start building the picture of what you build.'}
            </div>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {visible.map((r) => (
                <RepoCard
                  key={r.id}
                  repo={r}
                  syncing={syncingIds.has(r.id) || r.last_sync_status === 'running'}
                  selected={selected.has(r.id)}
                  onToggleSelect={() => toggleSelect(r.id)}
                  onToggleVisibility={() => toggleVisibility(r)}
                  onSync={() => runSync(r.id)}
                  onEdit={() => setEditing(r)}
                  onDelete={() => deleteRepo(r)}
                  onRemoveFromCollection={activeCollection ? () => removeFromActive(r.id) : undefined}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      <AddToCollectionBar kind="repository" selectedIds={selectedIds} onClear={() => setSelected(new Set())} />

      {editing && (
        <EditRepoModal
          repo={editing}
          onClose={() => setEditing(null)}
          onSave={async (notes) => {
            await patchRepo(editing.id, { notes })
            setEditing(null)
          }}
          onSyncWithFocus={async (focus) => {
            setEditing(null)
            await runSync(editing.id, focus)
          }}
        />
      )}
    </div>
  )
}

function EditRepoModal({
  repo,
  onClose,
  onSave,
  onSyncWithFocus,
}: {
  repo: Repo
  onClose: () => void
  onSave: (notes: string) => Promise<void>
  onSyncWithFocus: (focus: string) => Promise<void>
}) {
  const [notes, setNotes] = useState(repo.notes)
  const [focus, setFocus] = useState('')
  const [saving, setSaving] = useState(false)

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose} role="presentation">
      <div
        className="flex max-h-[90vh] w-full max-w-lg flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border px-5 py-3">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-text">
            <PencilIcon className="h-4 w-4 text-muted" /> {repo.full_name}
          </h2>
          <button onClick={onClose} title="Close" className="rounded-md p-1 text-faint hover:bg-surface-hover hover:text-muted">
            <CloseIcon className="h-4 w-4" />
          </button>
        </div>

        <div className="flex flex-col gap-4 overflow-y-auto px-5 py-4">
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium text-muted">Why this repo matters</span>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              placeholder="e.g. The customer-facing app. Billing lives in the api repo."
              className="resize-y rounded-lg border border-border-strong bg-surface px-3 py-2 text-sm outline-none focus:border-primary focus:ring-1 focus:ring-primary-soft"
            />
            <span className="text-xs text-faint">The assistant reads this note when it compiles the summary.</span>
          </label>

          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium text-muted">Re-sync with a focus (optional)</span>
            <input
              value={focus}
              onChange={(e) => setFocus(e.target.value)}
              placeholder="e.g. how authentication works, or the payments module"
              className="rounded-lg border border-border-strong bg-surface px-3 py-2 text-sm outline-none focus:border-primary focus:ring-1 focus:ring-primary-soft"
            />
            <span className="text-xs text-faint">Runs a sync that digs into this area while revising the summary.</span>
          </label>

          {repo.sync_summary && (
            <div className="rounded-lg border border-border bg-surface-2 p-3">
              <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-faint">Last change brief</p>
              <p className="whitespace-pre-wrap text-xs text-muted">{repo.sync_summary}</p>
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-border px-5 py-3">
          <button
            onClick={() => onSyncWithFocus(focus)}
            className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-sm font-medium text-muted transition hover:bg-surface-hover"
          >
            <LoopIcon className="h-4 w-4" /> Sync now{focus.trim() ? ' with focus' : ''}
          </button>
          <div className="flex items-center gap-2">
            <button onClick={onClose} className="rounded-lg border border-border px-3 py-2 text-sm font-medium text-muted transition hover:bg-surface-hover">
              Cancel
            </button>
            <button
              onClick={async () => {
                setSaving(true)
                await onSave(notes.trim())
                setSaving(false)
              }}
              disabled={saving}
              className="rounded-lg bg-primary px-3 py-2 text-sm font-semibold text-white transition hover:bg-primary-strong disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function RepoCard({
  repo,
  syncing,
  selected,
  onToggleSelect,
  onToggleVisibility,
  onSync,
  onEdit,
  onDelete,
  onRemoveFromCollection,
}: {
  repo: Repo
  syncing: boolean
  selected: boolean
  onToggleSelect: () => void
  onToggleVisibility: () => void
  onSync: () => void
  onEdit: () => void
  onDelete: () => void
  onRemoveFromCollection?: () => void
}) {
  const sync = describeSync(syncing ? { ...repo, last_sync_status: 'running' } : repo)
  const meta = (repo.metadata ?? {}) as { pushed_at?: string | null; forks?: number; open_issues?: number }
  const toneClass =
    sync.tone === 'error' ? 'text-red-600' : sync.tone === 'busy' ? 'text-primary' : sync.tone === 'ok' ? 'text-muted' : 'text-faint'

  return (
    <div
      className={`group flex flex-col overflow-hidden rounded-xl border bg-surface transition ${
        selected ? 'border-primary' : 'border-border hover:border-border-strong'
      }`}
    >
      <div className="flex flex-1 flex-col gap-1.5 px-4 py-3">
        <div className="flex items-start gap-2">
          <RepoIcon className="mt-0.5 h-4 w-4 shrink-0 text-muted" />
          <a href={repo.url} target="_blank" rel="noreferrer" className="min-w-0 flex-1">
            <span className="line-clamp-2 break-all text-sm font-semibold text-text group-hover:text-primary">{repo.full_name}</span>
          </a>
          {repo.is_private && (
            <span title="Private on GitHub" className="shrink-0 rounded-full bg-surface-2 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-faint">
              private
            </span>
          )}
        </div>
        <p className="truncate text-[11px] uppercase tracking-wide text-faint">
          {[repo.language, repo.stars ? `★ ${repo.stars}` : null, meta.pushed_at ? `pushed ${relativeTime(meta.pushed_at)}` : null]
            .filter(Boolean)
            .join(' · ') || 'github'}
        </p>
        {repo.description && <p className="line-clamp-3 text-xs text-muted">{repo.description}</p>}
        {repo.notes && <p className="line-clamp-2 text-xs italic text-faint">{repo.notes}</p>}
        <p className={`mt-1 flex items-center gap-1.5 text-xs ${toneClass}`}>
          {syncing && <LoopIcon className="h-3.5 w-3.5 animate-spin" />}
          {sync.label}
          {repo.last_sync_status === 'error' && repo.last_sync_error && (
            <span className="truncate" title={repo.last_sync_error}>
              — {repo.last_sync_error}
            </span>
          )}
        </p>
        {repo.sync_summary && !syncing && (
          <details className="text-xs text-muted">
            <summary className="cursor-pointer select-none text-faint hover:text-muted">What changed last sync</summary>
            <p className="mt-1 whitespace-pre-wrap">{repo.sync_summary}</p>
          </details>
        )}
      </div>

      {/* Footer: visibility + actions */}
      <div className="flex items-center gap-1 border-t border-border px-3 py-2">
        <button
          onClick={onToggleVisibility}
          title={repo.visibility === 'workspace' ? 'Shared with the workspace' : 'Private to you'}
          className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide transition ${
            repo.visibility === 'workspace' ? 'bg-primary-soft text-primary' : 'bg-surface-2 text-faint hover:text-muted'
          }`}
        >
          {repo.visibility === 'workspace' ? 'Team' : 'Mine'}
        </button>

        <div className="ml-auto flex shrink-0 items-center gap-1">
          {onRemoveFromCollection && (
            <button onClick={onRemoveFromCollection} title="Remove from this collection" className="rounded-md p-1 text-faint hover:bg-surface-hover hover:text-muted">
              <CollectionIcon className="h-4 w-4" />
            </button>
          )}
          {repo.artifact_id ? (
            <>
              <Link to={`/artifacts/${repo.artifact_id}`} title="Open the summary artifact" className="rounded-md p-1 text-faint hover:bg-surface-hover hover:text-muted">
                <ArtifactIcon className="h-4 w-4" />
              </Link>
              <Link
                to={`/chat?artifact=${repo.artifact_id}`}
                title="Chat about this repository (summary open beside the thread)"
                className="rounded-md p-1 text-faint hover:bg-surface-hover hover:text-muted"
              >
                <ChatIcon className="h-4 w-4" />
              </Link>
            </>
          ) : (
            <span title="Sync to compile the summary first" className="rounded-md p-1 text-faint/50">
              <ArtifactIcon className="h-4 w-4" />
            </span>
          )}
          <button
            onClick={onSync}
            disabled={syncing}
            title={repo.artifact_id ? 'Re-sync: fold in the latest changes' : 'Sync: read the repo and compile its summary'}
            className="rounded-md p-1 text-faint hover:bg-surface-hover hover:text-muted disabled:opacity-50"
          >
            <LoopIcon className={`h-4 w-4 ${syncing ? 'animate-spin' : ''}`} />
          </button>
          <button onClick={onEdit} title="Notes & focused sync" className="rounded-md p-1 text-faint hover:bg-surface-hover hover:text-muted">
            <PencilIcon className="h-4 w-4" />
          </button>
          <button
            onClick={onToggleSelect}
            title="Select"
            className={`rounded-md p-1 hover:bg-surface-hover ${selected ? 'text-primary' : 'text-faint hover:text-muted'}`}
          >
            <CheckIcon className="h-4 w-4" />
          </button>
          <button onClick={onDelete} title="Disconnect" className="rounded-md p-1 text-faint hover:bg-surface-hover hover:text-red-600">
            <TrashIcon className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  )
}
