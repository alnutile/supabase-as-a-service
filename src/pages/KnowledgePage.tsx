// The Knowledge dashboard — the human end of the compiler.
//
// Four tabs, in the order attention should flow:
//   Review    conflicts and held updates. The compiler never picks a winner, so
//             this is where a person does. It leads on purpose.
//   Compiled  the maintained pages, grouped by kind.
//   Briefs    what each pass changed, plus a live checklist while one runs.
//   Policy    the per-collection trust boundary.
//
// A pass is kicked off in the background and followed over Realtime, because a
// real collection takes longer than a browser request.
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import type { Database, Json } from '../lib/database.types'
import { compileFunctionUrl, supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import { Markdown } from '../components/Markdown'
import {
  AUTONOMY_HELP,
  AUTONOMY_LEVELS,
  KIND_LABELS,
  PAGE_KINDS,
  SOURCE_KINDS,
  groupByKind,
  needsAttention,
  parseGuards,
  readPolicy,
  runProgress,
  statusLabel,
  statusTone,
  summarizeRun,
  writePolicy,
  type Autonomy,
  type PageKind,
  type SourceKind,
  type Tone,
  type UiPolicy,
} from '../lib/compiler'
import { CheckIcon, CloseIcon, CollectionIcon, CompilerIcon, SparkleIcon } from '../components/icons'

type Page = Database['public']['Tables']['knowledge_pages']['Row']
type Conflict = Database['public']['Tables']['knowledge_conflicts']['Row']
type Run = Database['public']['Tables']['compile_runs']['Row']
type Collection = Database['public']['Tables']['collections']['Row']
type Policy = Database['public']['Tables']['compile_policies']['Row']

type Tab = 'review' | 'compiled' | 'briefs' | 'policy'

const TONE_CLASS: Record<Tone, string> = {
  neutral: 'bg-surface-muted text-muted',
  good: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  warn: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
  danger: 'bg-rose-500/10 text-rose-600 dark:text-rose-400',
}

function StatusChip({ status }: { status: string }) {
  return (
    <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${TONE_CLASS[statusTone(status)]}`}>
      {statusLabel(status)}
    </span>
  )
}

export default function KnowledgePage() {
  const { user } = useAuth()
  const [params, setParams] = useSearchParams()
  const [tab, setTab] = useState<Tab>('review')

  const [pages, setPages] = useState<Page[]>([])
  const [conflicts, setConflicts] = useState<Conflict[]>([])
  const [runs, setRuns] = useState<Run[]>([])
  const [collections, setCollections] = useState<Collection[]>([])
  const [policies, setPolicies] = useState<Record<string, Policy>>({})
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')

  const activeCollection = params.get('collection')
  const [openPage, setOpenPage] = useState<Page | null>(null)
  const [openBrief, setOpenBrief] = useState<Run | null>(null)

  const load = useCallback(async () => {
    const [p, c, r, col, pol] = await Promise.all([
      supabase.from('knowledge_pages').select('*').neq('status', 'archived').order('updated_at', { ascending: false }),
      supabase.from('knowledge_conflicts').select('*').eq('status', 'open').order('created_at', { ascending: false }),
      supabase.from('compile_runs').select('*').order('started_at', { ascending: false }).limit(30),
      supabase.from('collections').select('*').order('name', { ascending: true }),
      supabase.from('compile_policies').select('*'),
    ])
    setPages(p.data ?? [])
    setConflicts(c.data ?? [])
    setRuns(r.data ?? [])
    setCollections(col.data ?? [])
    const map: Record<string, Policy> = {}
    for (const row of pol.data ?? []) map[row.collection_id] = row
    setPolicies(map)
    setLoading(false)
  }, [])

  useEffect(() => {
    load()
  }, [load])

  // Follow a running pass and new conflicts live.
  useEffect(() => {
    const channel = supabase
      .channel('knowledge-compiler')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'compile_runs' }, () => load())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'knowledge_conflicts' }, () => load())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'knowledge_pages' }, () => load())
      .subscribe()
    return () => {
      supabase.removeChannel(channel)
    }
  }, [load])

  const scopedPages = useMemo(
    () => (activeCollection ? pages.filter((p) => p.collection_id === activeCollection) : pages),
    [pages, activeCollection],
  )
  const scopedConflicts = useMemo(
    () => (activeCollection ? conflicts.filter((c) => c.collection_id === activeCollection) : conflicts),
    [conflicts, activeCollection],
  )
  const scopedRuns = useMemo(
    () => (activeCollection ? runs.filter((r) => r.collection_id === activeCollection) : runs),
    [runs, activeCollection],
  )
  const runningRun = useMemo(() => runs.find((r) => r.status === 'running') ?? null, [runs])
  const attentionCount = useMemo(
    () => scopedConflicts.length + scopedPages.filter((p) => needsAttention(p.status)).length,
    [scopedConflicts, scopedPages],
  )
  const collectionName = useCallback(
    (id: string | null) => collections.find((c) => c.id === id)?.name ?? 'Unfiled',
    [collections],
  )

  function setCollection(id: string | null) {
    const next = new URLSearchParams(params)
    if (id) next.set('collection', id)
    else next.delete('collection')
    setParams(next, { replace: true })
  }

  // --- actions -------------------------------------------------------------

  async function compileNow(collectionId: string) {
    if (busy) return
    setBusy(true)
    setNotice('')
    try {
      const { data: session } = await supabase.auth.getSession()
      const token = session.session?.access_token
      const res = await fetch(compileFunctionUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ collection: collectionId, background: true, trigger: 'manual' }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) setNotice(body?.error ?? `The pass could not start (HTTP ${res.status}).`)
      else {
        setNotice('Compiling — the change brief will appear under Briefs when the pass finishes.')
        setTab('briefs')
      }
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'The pass could not start.')
    } finally {
      setBusy(false)
      load()
    }
  }

  /**
   * Record the human's decision. `apply` writes the held/incoming text onto the
   * page and marks it confirmed — a person just read it, which is what
   * confirmation means. `keep` clears the disputed flag without a change.
   */
  async function decide(conflict: Conflict, decision: 'apply' | 'keep' | 'dismiss') {
    if (busy || !user) return
    setBusy(true)
    const now = new Date().toISOString()
    try {
      if (decision === 'apply') {
        const proposed = (conflict.proposed ?? null) as { op?: string; body?: string } | null
        const body = (proposed?.body ?? conflict.incoming_text ?? '').trim()
        if (conflict.page_id && body) {
          const page = pages.find((p) => p.id === conflict.page_id)
          const content =
            proposed?.op === 'append' && page
              ? `${(page.content ?? '').trimEnd()}\n\n<!-- approved ${now.slice(0, 10)} -->\n${body}`
              : body
          await supabase
            .from('knowledge_pages')
            .update({ content, status: 'confirmed', human_confirmed: true, last_reviewed_at: now })
            .eq('id', conflict.page_id)
        }
      } else if (decision === 'keep' && conflict.page_id) {
        await supabase
          .from('knowledge_pages')
          .update({ status: 'confirmed', human_confirmed: true, last_reviewed_at: now })
          .eq('id', conflict.page_id)
      }
      await supabase
        .from('knowledge_conflicts')
        .update({
          status: decision === 'dismiss' ? 'dismissed' : 'resolved',
          resolution: decision,
          resolved_by: user.id,
          resolved_at: now,
        })
        .eq('id', conflict.id)
    } finally {
      setBusy(false)
      load()
    }
  }

  async function confirmPage(page: Page) {
    const now = new Date().toISOString()
    await supabase
      .from('knowledge_pages')
      .update({ status: 'confirmed', human_confirmed: true, last_reviewed_at: now })
      .eq('id', page.id)
    load()
  }

  async function savePolicy(collectionId: string, next: UiPolicy) {
    if (!user) return
    await supabase
      .from('compile_policies')
      .upsert(
        { collection_id: collectionId, owner_id: user.id, policy: writePolicy(next) as Json },
        { onConflict: 'collection_id' },
      )
    load()
  }

  // --- render --------------------------------------------------------------

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-muted">Loading compiled knowledge...</p>
      </div>
    )
  }

  const tabs: Array<{ key: Tab; label: string; badge?: number }> = [
    { key: 'review', label: 'Review', badge: attentionCount },
    { key: 'compiled', label: 'Compiled', badge: scopedPages.length },
    { key: 'briefs', label: 'Briefs' },
    { key: 'policy', label: 'Policy' },
  ]

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-4xl px-6 py-8">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight text-text">
              <CompilerIcon className="h-6 w-6 text-muted" /> Knowledge
            </h1>
            <p className="mt-1 max-w-xl text-sm text-muted">
              Compiled pages are the workspace&rsquo;s maintained understanding. The files, links and messages behind
              them are the evidence — not the answer.
            </p>
          </div>
          {activeCollection && (
            <button
              onClick={() => compileNow(activeCollection)}
              disabled={busy || Boolean(runningRun)}
              className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-sm font-semibold text-white transition hover:bg-primary-strong disabled:opacity-50"
            >
              <SparkleIcon className="h-4 w-4" /> {runningRun ? 'Compiling…' : 'Compile now'}
            </button>
          )}
        </div>

        {notice && (
          <div className="mt-4 rounded-lg border border-border bg-surface-muted px-3 py-2 text-sm text-muted">{notice}</div>
        )}

        {/* Collection scope */}
        <div className="mt-5 flex flex-wrap gap-1.5">
          <button
            onClick={() => setCollection(null)}
            className={`rounded-full px-3 py-1 text-xs font-medium transition ${
              !activeCollection ? 'bg-primary text-white' : 'bg-surface-muted text-muted hover:text-text'
            }`}
          >
            All collections
          </button>
          {collections.map((c) => (
            <button
              key={c.id}
              onClick={() => setCollection(c.id)}
              className={`flex items-center gap-1 rounded-full px-3 py-1 text-xs font-medium transition ${
                activeCollection === c.id ? 'bg-primary text-white' : 'bg-surface-muted text-muted hover:text-text'
              }`}
            >
              <CollectionIcon className="h-3 w-3" /> {c.name}
            </button>
          ))}
        </div>

        {/* Tabs */}
        <div className="mt-5 flex gap-1 border-b border-border">
          {tabs.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium transition ${
                tab === t.key
                  ? 'border-primary text-text'
                  : 'border-transparent text-muted hover:text-text'
              }`}
            >
              {t.label}
              {t.badge ? (
                <span
                  className={`ml-1.5 rounded px-1.5 py-0.5 text-[11px] ${
                    t.key === 'review' && t.badge ? TONE_CLASS.warn : 'bg-surface-muted text-muted'
                  }`}
                >
                  {t.badge}
                </span>
              ) : null}
            </button>
          ))}
        </div>

        {/* --- Review ---------------------------------------------------- */}
        {tab === 'review' && (
          <div className="mt-5 space-y-3">
            {!scopedConflicts.length && !scopedPages.some((p) => needsAttention(p.status)) && (
              <p className="rounded-lg border border-border bg-surface px-4 py-6 text-center text-sm text-muted">
                Nothing needs you. Compiled knowledge is consistent.
              </p>
            )}

            {scopedConflicts.map((c) => (
              <div key={c.id} className="rounded-lg border border-border bg-surface p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${
                    c.category === 'held' ? TONE_CLASS.neutral : TONE_CLASS.danger
                  }`}>
                    {c.category === 'held' ? 'Held for review' : 'Conflict'}
                  </span>
                  <span className="text-[11px] uppercase tracking-wide text-muted">{c.severity}</span>
                  <h3 className="text-sm font-semibold text-text">{c.title}</h3>
                  <span className="ml-auto text-xs text-muted">{collectionName(c.collection_id)}</span>
                </div>

                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  <div>
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-muted">New source</p>
                    <p className="mt-1 whitespace-pre-wrap text-sm text-text">{c.incoming_text || '—'}</p>
                  </div>
                  <div>
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-muted">Existing knowledge</p>
                    <p className="mt-1 whitespace-pre-wrap text-sm text-text">{c.existing_text || '—'}</p>
                  </div>
                </div>
                {c.impact && (
                  <p className="mt-3 text-sm text-muted">
                    <span className="font-semibold text-text">Impact:</span> {c.impact}
                  </p>
                )}
                {c.suggested_action && (
                  <p className="mt-1 text-sm text-muted">
                    <span className="font-semibold text-text">You decide:</span> {c.suggested_action}
                  </p>
                )}

                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    onClick={() => decide(c, 'apply')}
                    disabled={busy}
                    className="rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-primary-strong disabled:opacity-50"
                  >
                    Use the new source
                  </button>
                  <button
                    onClick={() => decide(c, 'keep')}
                    disabled={busy}
                    className="rounded-lg border border-border-strong px-3 py-1.5 text-xs font-semibold text-text transition hover:bg-surface-muted disabled:opacity-50"
                  >
                    Keep what we have
                  </button>
                  <button
                    onClick={() => decide(c, 'dismiss')}
                    disabled={busy}
                    className="rounded-lg px-3 py-1.5 text-xs font-medium text-muted transition hover:text-text disabled:opacity-50"
                  >
                    Dismiss
                  </button>
                </div>
              </div>
            ))}

            {scopedPages
              .filter((p) => needsAttention(p.status))
              .map((p) => (
                <div key={p.id} className="flex items-center gap-2 rounded-lg border border-border bg-surface px-4 py-3">
                  <StatusChip status={p.status} />
                  <button onClick={() => setOpenPage(p)} className="text-sm font-medium text-text hover:underline">
                    {p.title}
                  </button>
                  <span className="text-xs text-muted">{KIND_LABELS[p.kind as PageKind] ?? p.kind}</span>
                  <button
                    onClick={() => confirmPage(p)}
                    className="ml-auto flex items-center gap-1 rounded-lg border border-border-strong px-2.5 py-1 text-xs font-semibold text-text transition hover:bg-surface-muted"
                  >
                    <CheckIcon className="h-3 w-3" /> Confirm
                  </button>
                </div>
              ))}
          </div>
        )}

        {/* --- Compiled --------------------------------------------------- */}
        {tab === 'compiled' && (
          <div className="mt-5 space-y-6">
            {!scopedPages.length && (
              <p className="rounded-lg border border-border bg-surface px-4 py-6 text-center text-sm text-muted">
                Nothing compiled yet.{' '}
                {activeCollection
                  ? 'Run a pass to build this collection’s first pages from the sources already filed in it.'
                  : 'Pick a collection and run a pass to build its first pages.'}
              </p>
            )}
            {groupByKind(scopedPages).map((group) => (
              <div key={group.kind}>
                <h2 className="text-xs font-semibold uppercase tracking-wide text-muted">{group.label}</h2>
                <div className="mt-2 space-y-1.5">
                  {group.pages.map((p) => (
                    <button
                      key={p.id}
                      onClick={() => setOpenPage(p as Page)}
                      className="flex w-full items-center gap-2 rounded-lg border border-border bg-surface px-4 py-2.5 text-left transition hover:border-border-strong"
                    >
                      <span className="flex-1 truncate text-sm font-medium text-text">{p.title}</span>
                      {(p as Page).human_confirmed && (
                        <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${TONE_CLASS.good}`}>✓ confirmed</span>
                      )}
                      {p.status !== 'compiled' && <StatusChip status={p.status} />}
                      <span className="text-xs text-muted">{collectionName((p as Page).collection_id)}</span>
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* --- Briefs ----------------------------------------------------- */}
        {tab === 'briefs' && (
          <div className="mt-5 space-y-2">
            {runningRun && (
              <div className="rounded-lg border border-primary/40 bg-surface p-4">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-semibold text-text">
                    Compiling {collectionName(runningRun.collection_id)}…
                  </p>
                  <span className="text-xs text-muted">{Math.round(runProgress(runningRun.progress) * 100)}%</span>
                </div>
                <ul className="mt-3 space-y-1">
                  {((runningRun.progress ?? []) as Array<{ key: string; label: string; state: string; note?: string }>).map(
                    (step) => (
                      <li key={step.key} className="flex items-center gap-2 text-sm">
                        <span
                          className={
                            step.state === 'done'
                              ? 'text-emerald-500'
                              : step.state === 'running'
                                ? 'text-primary'
                                : 'text-muted'
                          }
                        >
                          {step.state === 'done' ? '✓' : step.state === 'running' ? '◌' : step.state === 'skipped' ? '–' : '·'}
                        </span>
                        <span className={step.state === 'pending' ? 'text-muted' : 'text-text'}>{step.label}</span>
                        {step.note && <span className="text-xs text-muted">— {step.note}</span>}
                      </li>
                    ),
                  )}
                </ul>
              </div>
            )}

            {!scopedRuns.length && !runningRun && (
              <p className="rounded-lg border border-border bg-surface px-4 py-6 text-center text-sm text-muted">
                No compilation pass has run yet.
              </p>
            )}

            {scopedRuns
              .filter((r) => r.status !== 'running')
              .map((r) => (
                <button
                  key={r.id}
                  onClick={() => setOpenBrief(r)}
                  className="flex w-full items-center gap-3 rounded-lg border border-border bg-surface px-4 py-3 text-left transition hover:border-border-strong"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-text">{collectionName(r.collection_id)}</p>
                    <p className="truncate text-xs text-muted">{summarizeRun(r as never)}</p>
                  </div>
                  <span className="shrink-0 text-xs text-muted">{new Date(r.started_at).toLocaleString()}</span>
                </button>
              ))}
          </div>
        )}

        {/* --- Policy ----------------------------------------------------- */}
        {tab === 'policy' && (
          <div className="mt-5 space-y-3">
            <p className="text-sm text-muted">
              Compilation is not unrestricted autonomous editing. Each collection sets how freely its knowledge may be
              rewritten without a person.
            </p>
            {collections
              .filter((c) => !activeCollection || c.id === activeCollection)
              .map((c) => (
                <PolicyCard
                  key={c.id}
                  collection={c}
                  policy={readPolicy(policies[c.id]?.policy)}
                  lastCompiled={policies[c.id]?.last_compiled_at ?? null}
                  onSave={(next) => savePolicy(c.id, next)}
                  onCompile={() => compileNow(c.id)}
                  busy={busy || Boolean(runningRun)}
                />
              ))}
          </div>
        )}
      </div>

      {/* Page reader */}
      {openPage && (
        <Drawer title={openPage.title} onClose={() => setOpenPage(null)}>
          <div className="flex flex-wrap items-center gap-2">
            <StatusChip status={openPage.status} />
            <span className="text-xs text-muted">{KIND_LABELS[openPage.kind as PageKind] ?? openPage.kind}</span>
            <span className="text-xs text-muted">
              {openPage.last_reviewed_at
                ? `last reviewed ${new Date(openPage.last_reviewed_at).toLocaleDateString()}`
                : 'never human-reviewed'}
            </span>
            {!openPage.human_confirmed && (
              <button
                onClick={() => {
                  confirmPage(openPage)
                  setOpenPage(null)
                }}
                className="ml-auto flex items-center gap-1 rounded-lg border border-border-strong px-2.5 py-1 text-xs font-semibold text-text transition hover:bg-surface-muted"
              >
                <CheckIcon className="h-3 w-3" /> Confirm
              </button>
            )}
          </div>
          {openPage.status === 'contradicted' && (
            <p className={`mt-3 rounded px-3 py-2 text-sm ${TONE_CLASS.danger}`}>
              Newer evidence contradicts this page. Settle it under Review before relying on it.
            </p>
          )}
          <div className="prose prose-sm mt-4 max-w-none dark:prose-invert">
            <Markdown>{openPage.content || '_(empty)_'}</Markdown>
          </div>
        </Drawer>
      )}

      {/* Change brief */}
      {openBrief && (
        <Drawer title={`Change brief — ${collectionName(openBrief.collection_id)}`} onClose={() => setOpenBrief(null)}>
          <div className="prose prose-sm max-w-none dark:prose-invert">
            <Markdown>{openBrief.brief || openBrief.error || '_(no brief)_'}</Markdown>
          </div>
        </Drawer>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------

function Drawer({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/30" onClick={onClose}>
      <div
        className="h-full w-full max-w-xl overflow-y-auto border-l border-border bg-surface p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <h2 className="text-lg font-semibold text-text">{title}</h2>
          <button onClick={onClose} className="rounded p-1 text-muted transition hover:text-text">
            <CloseIcon className="h-4 w-4" />
          </button>
        </div>
        <div className="mt-4">{children}</div>
      </div>
    </div>
  )
}

function PolicyCard({
  collection,
  policy,
  lastCompiled,
  onSave,
  onCompile,
  busy,
}: {
  collection: Collection
  policy: UiPolicy
  lastCompiled: string | null
  onSave: (p: UiPolicy) => void
  onCompile: () => void
  busy: boolean
}) {
  const [draft, setDraft] = useState<UiPolicy>(policy)
  const [guards, setGuards] = useState(policy.neverAuto.join(', '))
  const [open, setOpen] = useState(false)

  // Re-seed the editor when the stored policy changes underneath it.
  useEffect(() => {
    setDraft(policy)
    setGuards(policy.neverAuto.join(', '))
  }, [policy])

  const dirty =
    JSON.stringify({ ...draft, neverAuto: parseGuards(guards) }) !== JSON.stringify(policy)

  function toggle<T extends string>(list: T[], value: T): T[] {
    return list.includes(value) ? list.filter((v) => v !== value) : [...list, value]
  }

  return (
    <div className="rounded-lg border border-border bg-surface p-4">
      <div className="flex flex-wrap items-center gap-2">
        <CollectionIcon className="h-4 w-4 text-muted" />
        <h3 className="text-sm font-semibold text-text">{collection.name}</h3>
        <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${draft.enabled ? TONE_CLASS.good : TONE_CLASS.neutral}`}>
          {draft.enabled ? draft.autonomy : 'off'}
        </span>
        <span className="text-xs text-muted">
          {lastCompiled ? `last pass ${new Date(lastCompiled).toLocaleDateString()}` : 'never compiled'}
        </span>
        <div className="ml-auto flex gap-2">
          <button
            onClick={onCompile}
            disabled={busy || !draft.enabled}
            className="rounded-lg border border-border-strong px-2.5 py-1 text-xs font-semibold text-text transition hover:bg-surface-muted disabled:opacity-50"
          >
            Compile now
          </button>
          <button onClick={() => setOpen((v) => !v)} className="rounded-lg px-2.5 py-1 text-xs font-medium text-muted transition hover:text-text">
            {open ? 'Close' : 'Edit'}
          </button>
        </div>
      </div>

      {open && (
        <div className="mt-4 space-y-4 border-t border-border pt-4">
          <label className="flex items-center gap-2 text-sm text-text">
            <input
              type="checkbox"
              checked={draft.enabled}
              onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}
            />
            Compile this collection
          </label>

          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-muted">How freely</p>
            <div className="mt-2 space-y-1.5">
              {AUTONOMY_LEVELS.map((level) => (
                <label key={level} className="flex items-start gap-2 text-sm text-text">
                  <input
                    type="radio"
                    className="mt-1"
                    checked={draft.autonomy === level}
                    onChange={() => setDraft({ ...draft, autonomy: level as Autonomy })}
                  />
                  <span>
                    <span className="font-medium capitalize">{level}</span>
                    <span className="block text-xs text-muted">{AUTONOMY_HELP[level]}</span>
                  </span>
                </label>
              ))}
            </div>
          </div>

          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-muted">Compile from</p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {SOURCE_KINDS.map((s) => (
                <button
                  key={s}
                  onClick={() => setDraft({ ...draft, compileSources: toggle(draft.compileSources, s as SourceKind) })}
                  className={`rounded-full px-2.5 py-1 text-xs font-medium transition ${
                    draft.compileSources.includes(s as SourceKind)
                      ? 'bg-primary text-white'
                      : 'bg-surface-muted text-muted hover:text-text'
                  }`}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>

          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-muted">Maintain</p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {PAGE_KINDS.map((k) => (
                <button
                  key={k}
                  onClick={() => setDraft({ ...draft, maintainKinds: toggle(draft.maintainKinds, k as PageKind) })}
                  className={`rounded-full px-2.5 py-1 text-xs font-medium transition ${
                    draft.maintainKinds.includes(k as PageKind)
                      ? 'bg-primary text-white'
                      : 'bg-surface-muted text-muted hover:text-text'
                  }`}
                >
                  {KIND_LABELS[k]}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="text-xs font-semibold uppercase tracking-wide text-muted">Never update automatically</label>
            <input
              type="text"
              value={guards}
              onChange={(e) => setGuards(e.target.value)}
              placeholder="financial commitments, client-facing, published"
              className="mt-1.5 w-full rounded-lg border border-border-strong bg-surface px-3 py-2 text-sm outline-none focus:border-primary focus:ring-1 focus:ring-primary-soft"
            />
            <p className="mt-1 text-xs text-muted">
              Comma-separated. Matched against a page&rsquo;s kind, its labels, or its title.
            </p>
          </div>

          <div className="flex flex-wrap gap-4">
            <label className="text-xs text-muted">
              Review below confidence
              <input
                type="number"
                min={0}
                max={1}
                step={0.05}
                value={draft.minConfidence}
                onChange={(e) => setDraft({ ...draft, minConfidence: Number(e.target.value) })}
                className="ml-2 w-20 rounded border border-border-strong bg-surface px-2 py-1 text-sm text-text"
              />
            </label>
            <label className="text-xs text-muted">
              Stale after (days)
              <input
                type="number"
                min={1}
                value={draft.staleDays}
                onChange={(e) => setDraft({ ...draft, staleDays: Number(e.target.value) })}
                className="ml-2 w-20 rounded border border-border-strong bg-surface px-2 py-1 text-sm text-text"
              />
            </label>
          </div>

          <button
            onClick={() => onSave({ ...draft, neverAuto: parseGuards(guards) })}
            disabled={!dirty}
            className="rounded-lg bg-primary px-3 py-2 text-sm font-semibold text-white transition hover:bg-primary-strong disabled:opacity-50"
          >
            Save policy
          </button>
        </div>
      )}
    </div>
  )
}
