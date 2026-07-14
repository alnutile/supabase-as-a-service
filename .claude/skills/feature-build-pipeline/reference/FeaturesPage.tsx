import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import { formatDate } from '../lib/util'
import { removeFeature, upsertFeature } from '../lib/features'
import { LinkIcon, PaperclipIcon, PlusIcon, TrashIcon } from '../components/icons'

// The self-improvement pipeline as a kanban. Lane moves are the approvals:
// idea → approved opens a GitHub issue the Claude Code action builds from;
// → ready merges the PR (merge = deploy). Side-effect moves go through the
// `features` edge function; plain metadata edits hit the table directly.

interface Feature {
  id: string
  title: string
  description: string
  screenshots: string[]
  lane: Lane
  issue_number: number | null
  pr_number: number | null
  pr_url: string | null
  pr_state: string | null
  last_error: string | null
  owner_id: string | null
  created_at: string
  updated_at: string
}

type Lane = 'idea' | 'approved' | 'ready' | 'shipped'

const LANES: { key: Lane; title: string; hint: string }[] = [
  { key: 'idea', title: 'Ideas', hint: 'Anyone can add. Screenshots welcome.' },
  { key: 'approved', title: 'Approved for work', hint: 'AI builds it and opens a PR.' },
  { key: 'ready', title: 'Approved to merge', hint: 'Dropping here merges the PR.' },
  { key: 'shipped', title: 'Shipped', hint: 'Merged — deploy runs from main.' },
]

async function callFeaturesFn(action: 'approve' | 'sync' | 'merge', id: string) {
  const { data: sess } = await supabase.auth.getSession()
  const token = sess.session?.access_token
  const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/features`
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
    },
    body: JSON.stringify({ action, id }),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`)
  return body
}

export default function FeaturesPage() {
  const { user } = useAuth()
  const [features, setFeatures] = useState<Feature[]>([])
  const [isAdmin, setIsAdmin] = useState(false)
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [detail, setDetail] = useState<Feature | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState<Lane | null>(null)
  const dragId = useRef<string | null>(null)

  const load = useCallback(async () => {
    const { data } = await supabase
      .from('features')
      .select('*')
      .order('updated_at', { ascending: false })
    setFeatures((data as unknown as Feature[]) ?? [])
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
      .then(({ data }) => setIsAdmin(Boolean(data?.is_admin)))
  }, [user])

  // Refresh PR state for in-flight cards when the board opens.
  useEffect(() => {
    if (!isAdmin) return
    const inFlight = features.filter((f) => f.issue_number && f.lane !== 'shipped')
    if (!inFlight.length) return
    Promise.allSettled(inFlight.map((f) => callFeaturesFn('sync', f.id))).then(() => load())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin])

  // Live board: the PR link (and lane/state) lands on the row asynchronously —
  // the `features` edge function syncs it in the background, so without Realtime
  // the freshly-synced PR only shows after a manual reload (issue #104). Push
  // every INSERT/UPDATE/DELETE straight into the list (and the open detail).
  useEffect(() => {
    if (!user) return
    const channel = supabase
      .channel('features-board')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'features' }, (payload) => {
        if (payload.eventType === 'DELETE') {
          const id = (payload.old as { id?: string })?.id
          if (!id) return
          setFeatures((prev) => removeFeature(prev, id))
          setDetail((d) => (d?.id === id ? null : d))
          return
        }
        const row = payload.new as Feature
        if (!row?.id) return
        setFeatures((prev) => upsertFeature(prev, row))
        setDetail((d) => (d?.id === row.id ? row : d))
      })
      .subscribe()
    return () => {
      supabase.removeChannel(channel)
    }
  }, [user])

  async function moveTo(feature: Feature, lane: Lane) {
    if (!isAdmin || feature.lane === lane) return
    setNotice(null)
    try {
      if (lane === 'approved' && !feature.issue_number) {
        if (!confirm(`Approve “${feature.title}” for AI work?\n\nThis opens a GitHub issue; the coding agent will implement it and open a PR for review.\n\n⚠️ If the repo is public, the issue is too: the card's title, description, and screenshots become publicly visible the moment it opens.`)) return
        await callFeaturesFn('approve', feature.id)
      } else if (lane === 'ready') {
        if (!confirm(`Merge the PR for “${feature.title}”?\n\nMerging main deploys to production (app + migrations + functions).`)) return
        await supabase.from('features').update({ lane: 'ready', updated_at: new Date().toISOString() }).eq('id', feature.id)
        await callFeaturesFn('merge', feature.id)
      } else {
        await supabase.from('features').update({ lane, updated_at: new Date().toISOString() }).eq('id', feature.id)
      }
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Something went wrong.')
    }
    load()
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex items-center justify-between px-6 pt-8 pb-1">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-text">Features</h1>
          <p className="mt-1 text-sm text-muted">
            Ideas in, shipped code out. Dragging a card is the approval: into{' '}
            <strong>Approved for work</strong> the AI builds it (PR for review); into{' '}
            <strong>Approved to merge</strong> the PR merges and deploys.
          </p>
        </div>
        <button
          onClick={() => setCreating(true)}
          className="flex shrink-0 items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white hover:bg-primary-strong"
        >
          <PlusIcon className="h-4 w-4" /> New idea
        </button>
      </div>

      {notice && (
        <div className="mx-6 mt-3 rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">
          {notice}
        </div>
      )}

      <div className="flex flex-1 gap-4 overflow-x-auto px-6 py-4">
        {LANES.map((lane) => {
          const cards = features.filter((f) => f.lane === lane.key)
          return (
            <div
              key={lane.key}
              onDragOver={(e) => {
                if (!isAdmin) return
                e.preventDefault()
                setDragOver(lane.key)
              }}
              onDragLeave={() => setDragOver((d) => (d === lane.key ? null : d))}
              onDrop={(e) => {
                e.preventDefault()
                setDragOver(null)
                const f = features.find((x) => x.id === dragId.current)
                if (f) moveTo(f, lane.key)
              }}
              className={`flex w-72 shrink-0 flex-col rounded-xl border bg-surface-2/50 ${
                dragOver === lane.key ? 'border-primary ring-2 ring-primary-soft' : 'border-border'
              }`}
            >
              <div className="px-3 pt-3">
                <div className="flex items-center justify-between">
                  <h2 className="text-sm font-semibold text-text">{lane.title}</h2>
                  <span className="rounded-full bg-surface-2 px-2 text-xs text-muted">{cards.length}</span>
                </div>
                <p className="mt-0.5 text-[11px] text-faint">{lane.hint}</p>
              </div>
              <div className="flex-1 space-y-2 overflow-y-auto p-3">
                {cards.map((f) => (
                  <div
                    key={f.id}
                    draggable={isAdmin}
                    onDragStart={() => (dragId.current = f.id)}
                    onClick={() => setDetail(f)}
                    className="cursor-pointer rounded-lg border border-border bg-surface p-3 shadow-sm hover:border-border-strong"
                  >
                    <div className="text-sm font-medium text-text">{f.title}</div>
                    {f.description && (
                      <p className="mt-1 line-clamp-2 text-xs text-muted">{f.description}</p>
                    )}
                    <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-faint">
                      {f.screenshots.length > 0 && (
                        <span className="flex items-center gap-1">
                          <PaperclipIcon className="h-3 w-3" /> {f.screenshots.length}
                        </span>
                      )}
                      {f.issue_number && (
                        <span className="rounded-full bg-surface-2 px-1.5 py-0.5">#{f.issue_number}</span>
                      )}
                      {f.pr_url && (
                        <a
                          href={f.pr_url}
                          target="_blank"
                          rel="noreferrer"
                          onClick={(e) => e.stopPropagation()}
                          className={`flex items-center gap-1 rounded-full px-1.5 py-0.5 font-medium ${
                            f.pr_state === 'merged'
                              ? 'bg-emerald-100 text-emerald-700'
                              : f.pr_state === 'closed'
                                ? 'bg-red-100 text-red-700'
                                : 'bg-primary-soft text-primary'
                          }`}
                        >
                          <LinkIcon className="h-3 w-3" /> PR {f.pr_number} · {f.pr_state ?? 'open'}
                        </a>
                      )}
                      {f.issue_number && !f.pr_url && f.lane === 'approved' && (
                        <span className="rounded-full bg-amber-50 px-1.5 py-0.5 text-amber-700">building…</span>
                      )}
                      <span>{formatDate(f.updated_at)}</span>
                    </div>
                    {f.last_error && (
                      <p className="mt-2 rounded bg-red-50 px-2 py-1 text-[11px] text-red-700">{f.last_error}</p>
                    )}
                  </div>
                ))}
                {!loading && cards.length === 0 && (
                  <p className="px-1 py-2 text-center text-xs text-faint">Empty</p>
                )}
              </div>
            </div>
          )
        })}
      </div>

      {!isAdmin && (
        <p className="px-6 pb-3 text-xs text-faint">
          Anyone can file ideas; moving cards between lanes is admin-only.
        </p>
      )}

      {creating && (
        <NewIdeaModal
          onClose={() => setCreating(false)}
          onSaved={() => {
            setCreating(false)
            load()
          }}
        />
      )}
      {detail && (
        <DetailModal
          feature={detail}
          isAdmin={isAdmin}
          isOwner={detail.owner_id === user?.id}
          onClose={() => setDetail(null)}
          onChanged={() => {
            setDetail(null)
            load()
          }}
        />
      )}
    </div>
  )
}

function NewIdeaModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const { user } = useAuth()
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [files, setFiles] = useState<File[]>([])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function save() {
    if (!title.trim() || !user) return
    setSaving(true)
    setError(null)
    try {
      const paths: string[] = []
      for (const file of files) {
        const path = `${user.id}/features/${Date.now()}-${file.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`
        const { error: upErr } = await supabase.storage.from('files').upload(path, file)
        if (upErr) throw new Error(`Screenshot upload failed: ${upErr.message}`)
        paths.push(path)
      }
      const { error: insErr } = await supabase.from('features').insert({
        title: title.trim(),
        description: description.trim(),
        screenshots: paths,
        lane: 'idea',
        owner_id: user.id,
      })
      if (insErr) throw new Error(insErr.message)
      onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save.')
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/40 sm:items-center sm:p-4">
      <div className="flex max-h-[92vh] w-full max-w-lg flex-col overflow-hidden rounded-t-2xl bg-surface shadow-xl sm:rounded-2xl">
        <div className="border-b border-border px-5 py-3">
          <h2 className="text-sm font-semibold text-text">New idea</h2>
        </div>
        <div className="flex-1 space-y-4 overflow-y-auto p-5">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted">Title</span>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Clicking a skill in chat should arm it, not send a message"
              className="w-full rounded-lg border border-border-strong px-3 py-2 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary-soft"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted">
              Description — what's wrong / what you want. The coding agent reads this verbatim, so
              include where it happens and what "done" looks like.
            </span>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={6}
              className="w-full resize-y rounded-lg border border-border-strong px-3 py-2 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary-soft"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted">
              Screenshots (optional) — if an admin approves this card, they're posted to the GitHub
              issue (public on a public repo), so avoid capturing sensitive data.
            </span>
            <input
              type="file"
              accept="image/*"
              multiple
              onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
              className="block w-full text-sm text-muted file:mr-3 file:rounded-lg file:border-0 file:bg-surface-2 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-text"
            />
          </label>
          {error && <p className="text-sm text-red-600">{error}</p>}
        </div>
        <div className="flex justify-end gap-2 border-t border-border px-5 py-3">
          <button onClick={onClose} className="rounded-lg px-3 py-2 text-sm font-medium text-muted hover:bg-surface-hover">
            Cancel
          </button>
          <button
            onClick={save}
            disabled={saving || !title.trim()}
            className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white hover:bg-primary-strong disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Add idea'}
          </button>
        </div>
      </div>
    </div>
  )
}

function DetailModal({
  feature,
  isAdmin,
  isOwner,
  onClose,
  onChanged,
}: {
  feature: Feature
  isAdmin: boolean
  isOwner: boolean
  onClose: () => void
  onChanged: () => void
}) {
  const [urls, setUrls] = useState<string[]>([])
  const canDelete = isAdmin || (isOwner && feature.lane === 'idea')

  useEffect(() => {
    let alive = true
    Promise.all(
      (feature.screenshots ?? []).map(async (p) => {
        const { data } = await supabase.storage.from('files').createSignedUrl(p, 3600)
        return data?.signedUrl ?? null
      }),
    ).then((u) => alive && setUrls(u.filter((x): x is string => Boolean(x))))
    return () => {
      alive = false
    }
  }, [feature])

  async function remove() {
    if (!confirm(`Delete “${feature.title}”?`)) return
    await supabase.from('features').delete().eq('id', feature.id)
    onChanged()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/40 sm:items-center sm:p-4" onClick={onClose}>
      <div
        className="flex max-h-[92vh] w-full max-w-xl flex-col overflow-hidden rounded-t-2xl bg-surface shadow-xl sm:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border px-5 py-3">
          <h2 className="text-sm font-semibold text-text">{feature.title}</h2>
          {canDelete && (
            <button onClick={remove} className="rounded-md p-1.5 text-faint hover:bg-red-50 hover:text-red-600" title="Delete">
              <TrashIcon className="h-[18px] w-[18px]" />
            </button>
          )}
        </div>
        <div className="flex-1 space-y-4 overflow-y-auto p-5">
          <p className="whitespace-pre-wrap text-sm text-text">{feature.description || 'No description.'}</p>
          <div className="flex flex-wrap gap-2 text-xs text-muted">
            <span className="rounded-full bg-surface-2 px-2 py-0.5">{feature.lane}</span>
            {feature.issue_number && <span className="rounded-full bg-surface-2 px-2 py-0.5">issue #{feature.issue_number}</span>}
            {feature.pr_url && (
              <a href={feature.pr_url} target="_blank" rel="noreferrer" className="rounded-full bg-primary-soft px-2 py-0.5 text-primary">
                PR #{feature.pr_number} · {feature.pr_state ?? 'open'}
              </a>
            )}
          </div>
          {feature.last_error && (
            <p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{feature.last_error}</p>
          )}
          {urls.map((u) => (
            <img key={u} src={u} alt="screenshot" className="max-w-full rounded-lg border border-border" />
          ))}
        </div>
      </div>
    </div>
  )
}
