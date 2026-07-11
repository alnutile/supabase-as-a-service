import { useCallback, useEffect, useState } from 'react'
import type { Database } from '../lib/database.types'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import { formatDate } from '../lib/util'
import { EvalIcon, PlayIcon, PlusIcon, TrashIcon } from '../components/icons'

type Suite = Database['public']['Tables']['eval_suites']['Row']
type Case = Database['public']['Tables']['eval_cases']['Row']
type Run = Database['public']['Tables']['eval_runs']['Row']
type Result = Database['public']['Tables']['eval_results']['Row']
type AgentLite = { id: string; name: string }
type CollectionLite = { id: string; name: string }

type AssertionRow = { type: string; value: string; k: number }
type StoredAssertion = { type: string; doc?: string; text?: string; pattern?: string; k?: number }
type AssertionResult = { type: string; pass: boolean; detail: string }
type Judge = { pass: boolean; score: number; reason: string }

const ASSERTION_TYPES = [
  { value: 'contains', label: 'Answer contains', hint: 'the text contains…' },
  { value: 'not_contains', label: "Answer doesn't contain", hint: 'the text must NOT contain…' },
  { value: 'regex', label: 'Answer matches regex', hint: 'a regular expression' },
  { value: 'retrieves', label: 'Retrieves document (rag)', hint: 'a document whose name contains…' },
  { value: 'recall_at_k', label: 'Retrieves in top-k (rag)', hint: 'document name contains… within top k' },
]

const TARGETS = [
  { value: 'rag', label: 'Retrieval (rag)', blurb: 'Scores whether search_documents finds the right passages. Deterministic, no judge.' },
  { value: 'chat', label: 'Chat answer', blurb: 'Answers each question through the real chat pipeline, then a judge model grades it vs. your reference answer.' },
  { value: 'agent', label: 'Agent answer', blurb: "Runs each question through a specific agent's prompt + tools, then judges the answer." },
]

function valueField(type: string): 'doc' | 'text' | 'pattern' {
  if (type === 'retrieves' || type === 'recall_at_k') return 'doc'
  if (type === 'regex') return 'pattern'
  return 'text'
}

function toRows(assertions: unknown): AssertionRow[] {
  const arr = Array.isArray(assertions) ? (assertions as StoredAssertion[]) : []
  return arr.map((a) => ({ type: a.type ?? 'contains', value: String(a.doc ?? a.text ?? a.pattern ?? ''), k: Number(a.k ?? 5) }))
}

function toStored(rows: AssertionRow[]): StoredAssertion[] {
  return rows
    .filter((r) => r.value.trim() !== '')
    .map((r) => {
      const out: StoredAssertion = { type: r.type }
      out[valueField(r.type)] = r.value.trim()
      if (r.type === 'recall_at_k') out.k = Math.max(1, Math.min(20, r.k || 5))
      return out
    })
}

export default function EvalsPage() {
  const { user } = useAuth()
  const [isAdmin, setIsAdmin] = useState(false)
  const [suites, setSuites] = useState<Suite[]>([])
  const [latest, setLatest] = useState<Record<string, Run>>({})
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<Suite | null>(null)

  const load = useCallback(async () => {
    const { data } = await supabase.from('eval_suites').select('*').order('updated_at', { ascending: false })
    setSuites(data ?? [])
    setLoading(false)
    // Latest run per suite (for the scorecard badges) — reduce recent runs client-side.
    const { data: runs } = await supabase
      .from('eval_runs')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(300)
    const bySuite: Record<string, Run> = {}
    for (const r of runs ?? []) if (!bySuite[r.suite_id]) bySuite[r.suite_id] = r
    setLatest(bySuite)
  }, [])

  useEffect(() => {
    load()
  }, [load])

  useEffect(() => {
    if (!user) return
    supabase.from('profiles').select('is_admin').eq('id', user.id).maybeSingle().then(({ data }) => setIsAdmin(Boolean(data?.is_admin)))
  }, [user])

  async function createSuite() {
    const { data } = await supabase.from('eval_suites').insert({ name: 'New eval suite', target_kind: 'rag' }).select().single()
    if (data) {
      await load()
      setSelected(data)
    }
  }

  if (!isAdmin) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-faint">
        <EvalIcon className="h-10 w-10" />
        <p className="max-w-sm text-sm">Evals are managed by workspace admins.</p>
      </div>
    )
  }

  if (selected) return <SuiteDetail suite={selected} onBack={() => { setSelected(null); load() }} />

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl px-6 py-8">
        <div className="mb-1 flex items-center justify-between">
          <h1 className="text-2xl font-semibold tracking-tight text-text">Evals</h1>
          <button onClick={createSuite} className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white hover:bg-primary-strong">
            <PlusIcon className="h-4 w-4" /> New suite
          </button>
        </div>
        <p className="mb-6 text-sm text-muted">
          Define questions + reference answers, run them through the real pipeline, and grade them — like Promptfoo.
          <strong> Retrieval</strong> suites score whether <code className="rounded bg-surface-2 px-1">search_documents</code> finds
          the right passages (deterministic). <strong>Chat / agent</strong> suites answer each question through the live
          assistant and grade it with a judge model against your reference answer.
        </p>

        {loading ? (
          <p className="text-sm text-faint">Loading…</p>
        ) : suites.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border-strong p-8 text-center text-sm text-muted">
            No eval suites yet. Create one, pick a target, add cases, and run it.
          </div>
        ) : (
          <div className="space-y-3">
            {suites.map((s) => (
              <button key={s.id} onClick={() => setSelected(s)} className="flex w-full items-center gap-3 rounded-xl border border-border bg-surface p-4 text-left hover:border-border-strong">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-muted">
                  <EvalIcon className="h-5 w-5" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium text-text">{s.name}</span>
                    <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted">{s.target_kind}</span>
                  </div>
                  <p className="mt-0.5 line-clamp-1 text-xs text-muted">{s.description || 'No description'} · {formatDate(s.updated_at)}</p>
                </div>
                {latest[s.id] ? (
                  <SuiteScorePill run={latest[s.id]} />
                ) : (
                  <span className="shrink-0 text-[11px] text-faint">not run</span>
                )}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function SuiteDetail({ suite, onBack }: { suite: Suite; onBack: () => void }) {
  const [name, setName] = useState(suite.name)
  const [description, setDescription] = useState(suite.description)
  const [targetKind, setTargetKind] = useState(suite.target_kind)
  const [agentId, setAgentId] = useState(suite.agent_id ?? '')
  const [rubric, setRubric] = useState(suite.rubric)
  const [judgeModel, setJudgeModel] = useState(suite.judge_model ?? '')
  const [collectionIds, setCollectionIds] = useState<string[]>(suite.collection_ids ?? [])
  const [agents, setAgents] = useState<AgentLite[]>([])
  const [collections, setCollections] = useState<CollectionLite[]>([])
  const [cases, setCases] = useState<Case[]>([])
  const [runs, setRuns] = useState<Run[]>([])
  const [activeRun, setActiveRun] = useState<string | null>(null)
  const [results, setResults] = useState<Result[]>([])
  const [editing, setEditing] = useState<Case | 'new' | null>(null)
  const [running, setRunning] = useState(false)
  const [modelOverride, setModelOverride] = useState('')
  const [compareModels, setCompareModels] = useState('')
  const [error, setError] = useState('')

  const isJudged = targetKind === 'chat' || targetKind === 'agent'

  const loadCases = useCallback(async () => {
    const { data } = await supabase.from('eval_cases').select('*').eq('suite_id', suite.id).order('created_at')
    setCases(data ?? [])
  }, [suite.id])

  const loadRuns = useCallback(async () => {
    const { data } = await supabase.from('eval_runs').select('*').eq('suite_id', suite.id).order('created_at', { ascending: false }).limit(20)
    setRuns(data ?? [])
    setActiveRun((prev) => prev ?? data?.[0]?.id ?? null)
  }, [suite.id])

  useEffect(() => {
    loadCases()
    loadRuns()
    supabase.from('agents').select('id, name').order('name').then(({ data }) => setAgents(data ?? []))
    supabase.from('collections').select('id, name').order('name').then(({ data }) => setCollections(data ?? []))
  }, [loadCases, loadRuns])

  useEffect(() => {
    if (!activeRun) { setResults([]); return }
    supabase.from('eval_results').select('*').eq('run_id', activeRun).order('created_at').then(({ data }) => setResults(data ?? []))
  }, [activeRun])

  async function saveMeta(patch: Partial<Suite>) {
    await supabase.from('eval_suites').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', suite.id)
  }

  async function deleteCase(c: Case) {
    if (!confirm('Delete this case?')) return
    await supabase.from('eval_cases').delete().eq('id', c.id)
    loadCases()
  }

  async function run() {
    setRunning(true)
    setError('')
    const payload: { suite_id: string; model?: string } = { suite_id: suite.id }
    if (modelOverride.trim()) payload.model = modelOverride.trim()
    const { data, error: invokeErr } = await supabase.functions.invoke('evals', { body: payload })
    if (invokeErr) {
      let msg = invokeErr.message
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const j = await (invokeErr as any).context.json()
        if (j?.error) msg = j.error
      } catch { /* keep generic */ }
      setError(msg)
    } else if (data?.error) {
      setError(data.error)
    } else {
      await loadRuns()
      if (data?.run_id) setActiveRun(data.run_id)
    }
    setRunning(false)
  }

  function toggleCollection(id: string) {
    const next = collectionIds.includes(id) ? collectionIds.filter((c) => c !== id) : [...collectionIds, id]
    setCollectionIds(next)
    saveMeta({ collection_ids: next })
  }

  // Model matrix: fire a background run per model, then poll until they settle so
  // the trend strip + run picker fill in with the side-by-side comparison.
  async function compare() {
    const models = compareModels.split(/[\n,]/).map((m) => m.trim()).filter(Boolean)
    if (models.length === 0) return
    setRunning(true)
    setError('')
    const { data, error: invokeErr } = await supabase.functions.invoke('evals', {
      body: { suite_id: suite.id, models, background: true },
    })
    if (invokeErr) {
      let msg = invokeErr.message
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const j = await (invokeErr as any).context.json()
        if (j?.error) msg = j.error
      } catch { /* keep generic */ }
      setError(msg)
      setRunning(false)
      return
    }
    if (data?.error) {
      setError(data.error)
      setRunning(false)
      return
    }
    const runIds: string[] = data?.run_ids ?? []
    if (runIds.length && data?.run_id !== null) setActiveRun(runIds[0])
    // Poll the launched runs until none are still running (cap ~2 min).
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 2000))
      const { data: rows } = await supabase.from('eval_runs').select('status').in('id', runIds)
      await loadRuns()
      if ((rows ?? []).every((r) => r.status !== 'running')) break
    }
    setRunning(false)
  }

  const current = runs.find((r) => r.id === activeRun) ?? null

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl px-6 py-8">
        <button onClick={onBack} className="mb-4 text-sm text-muted hover:text-text">← All suites</button>

        <div className="mb-6 rounded-xl border border-border bg-surface p-4">
          <input value={name} onChange={(e) => setName(e.target.value)} onBlur={() => saveMeta({ name })}
            className="w-full bg-transparent text-xl font-semibold tracking-tight text-text outline-none" />
          <input value={description} onChange={(e) => setDescription(e.target.value)} onBlur={() => saveMeta({ description })}
            placeholder="Optional description" className="mt-1 w-full bg-transparent text-sm text-muted outline-none" />

          {/* Target + judge settings */}
          <div className="mt-3 space-y-3 border-t border-border pt-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-medium text-muted">Target</span>
              <select value={targetKind} onChange={(e) => { setTargetKind(e.target.value); saveMeta({ target_kind: e.target.value }) }}
                className="rounded-md border border-border-strong bg-surface px-2 py-1.5 text-xs">
                {TARGETS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
              {targetKind === 'agent' && (
                <select value={agentId} onChange={(e) => { setAgentId(e.target.value); saveMeta({ agent_id: e.target.value || null }) }}
                  className="rounded-md border border-border-strong bg-surface px-2 py-1.5 text-xs">
                  <option value="">Pick an agent…</option>
                  {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
              )}
            </div>
            <p className="text-xs text-faint">{TARGETS.find((t) => t.value === targetKind)?.blurb}</p>

            {isJudged && (
              <>
                <label className="block">
                  <span className="mb-1 block text-xs font-medium text-muted">Grading rubric (how the judge should score)</span>
                  <textarea value={rubric} onChange={(e) => setRubric(e.target.value)} onBlur={() => saveMeta({ rubric })} rows={2}
                    placeholder="Default: pass if the answer is factually consistent with the reference and answers the question; wording/format differences are fine."
                    className="w-full resize-y rounded-lg border border-border-strong px-3 py-2 text-sm outline-none focus:border-primary" />
                </label>
                <label className="block">
                  <span className="mb-1 block text-xs font-medium text-muted">Judge model (optional OpenRouter slug — blank = utility profile)</span>
                  <input value={judgeModel} onChange={(e) => setJudgeModel(e.target.value)} onBlur={() => saveMeta({ judge_model: judgeModel.trim() || null })}
                    placeholder="e.g. anthropic/claude-sonnet-4.5" className="w-full rounded-lg border border-border-strong px-3 py-2 text-sm outline-none focus:border-primary" />
                </label>
                <div>
                  <span className="mb-1 block text-xs font-medium text-muted">Grounding collections (optional — answers are graded FROM these)</span>
                  {collections.length === 0 ? (
                    <p className="text-xs text-faint">No collections yet. Create one to ground answers in a specific knowledge set.</p>
                  ) : (
                    <div className="flex flex-wrap gap-1.5">
                      {collections.map((c) => {
                        const on = collectionIds.includes(c.id)
                        return (
                          <button key={c.id} onClick={() => toggleCollection(c.id)}
                            className={`rounded-full border px-2.5 py-1 text-xs ${on ? 'border-primary bg-primary/10 text-primary' : 'border-border-strong text-muted hover:bg-surface-hover'}`}>
                            {on ? '✓ ' : ''}{c.name}
                          </button>
                        )
                      })}
                    </div>
                  )}
                  <p className="mt-1 text-xs text-faint">When set, each question is answered with only these collections' content as context — so you test whether the assistant answers correctly out of that set.</p>
                </div>
              </>
            )}
          </div>

          {/* Run controls */}
          <div className="mt-3 flex flex-wrap items-center gap-3 border-t border-border pt-3">
            <button onClick={run} disabled={running || cases.length === 0}
              className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white hover:bg-primary-strong disabled:opacity-50">
              <PlayIcon className="h-4 w-4" /> {running ? 'Running…' : 'Run suite'}
            </button>
            <input value={modelOverride} onChange={(e) => setModelOverride(e.target.value)} placeholder="model override (slug) — for A/B"
              title="Run with a specific model to compare quality/cost. Blank = the orchestrator profile."
              className="w-60 rounded-lg border border-border-strong px-3 py-2 text-xs outline-none focus:border-primary" />
            <span className="text-xs text-faint">{cases.length} case{cases.length === 1 ? '' : 's'}</span>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-border pt-2">
            <span className="text-xs font-medium text-muted">Compare models</span>
            <input value={compareModels} onChange={(e) => setCompareModels(e.target.value)}
              placeholder="comma-separated slugs, e.g. anthropic/claude-sonnet-4.5, anthropic/claude-haiku-4.5, openai/gpt-4o"
              title="Run the whole suite once per model, in the background, then compare the scores in the trend strip below."
              className="min-w-0 flex-1 rounded-lg border border-border-strong px-3 py-2 text-xs outline-none focus:border-primary" />
            <button onClick={compare} disabled={running || cases.length === 0 || !compareModels.trim()}
              className="rounded-lg border border-border-strong px-3 py-2 text-xs font-semibold text-muted hover:bg-surface-hover disabled:opacity-50">
              {running ? 'Comparing…' : 'Compare'}
            </button>
          </div>
          {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
        </div>

        {runs.length > 0 && <TrendStrip runs={runs} activeRun={activeRun} onSelect={setActiveRun} />}

        {current && (
          <div className="mb-6">
            <div className="mb-2 flex flex-wrap items-center gap-3">
              <ScoreBadge run={current} />
              <span className="text-xs text-faint">
                {formatDate(current.created_at)}
                {current.model ? ` · ${current.model}` : ''}
                {current.cost != null ? ` · $${current.cost.toFixed(4)}` : ''}
                {current.status === 'error' ? ' · errored' : ''}
              </span>
              {runs.length > 1 && (
                <select value={activeRun ?? ''} onChange={(e) => setActiveRun(e.target.value)} className="ml-auto rounded-md border border-border-strong bg-surface px-2 py-1 text-xs">
                  {runs.map((r) => (
                    <option key={r.id} value={r.id}>
                      {formatDate(r.created_at)} — {r.passed}/{r.total}{r.model ? ` (${r.model})` : ''}
                    </option>
                  ))}
                </select>
              )}
            </div>
            <div className="space-y-2">{results.map((res) => <ResultRow key={res.id} result={res} />)}</div>
          </div>
        )}

        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-text">Cases</h2>
          <button onClick={() => setEditing('new')} className="flex items-center gap-1.5 rounded-lg border border-border-strong px-3 py-1.5 text-xs font-medium text-muted hover:bg-surface-hover">
            <PlusIcon className="h-3.5 w-3.5" /> Add case
          </button>
        </div>
        <div className="space-y-2">
          {cases.map((c) => {
            const n = Array.isArray(c.assertions) ? c.assertions.length : 0
            return (
              <div key={c.id} className="flex items-start gap-3 rounded-xl border border-border bg-surface p-3">
                <button onClick={() => setEditing(c)} className="min-w-0 flex-1 text-left">
                  <p className="truncate text-sm font-medium text-text">{c.name || c.input}</p>
                  <p className="mt-0.5 line-clamp-1 text-xs text-muted">
                    “{c.input}”{c.expected ? ` · ref: ${c.expected.slice(0, 40)}…` : ''}{n ? ` · ${n} check${n === 1 ? '' : 's'}` : ''}
                  </p>
                </button>
                <button onClick={() => deleteCase(c)} className="rounded-md p-1.5 text-faint hover:bg-red-50 hover:text-red-600" title="Delete">
                  <TrashIcon className="h-4 w-4" />
                </button>
              </div>
            )
          })}
          {cases.length === 0 && (
            <p className="rounded-xl border border-dashed border-border-strong p-6 text-center text-xs text-muted">
              No cases yet. Add a question{isJudged ? ' + a reference answer to grade against' : ' + assertions about retrieval'}.
            </p>
          )}
        </div>
      </div>

      {editing && (
        <CaseEditor suiteId={suite.id} judged={isJudged} editingCase={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)} onSaved={() => { setEditing(null); loadCases() }} />
      )}
    </div>
  )
}

function ScoreBadge({ run }: { run: Run }) {
  const pct = run.score != null ? Math.round(run.score * 100) : null
  const tone = pct == null ? 'bg-surface-2 text-muted' : pct >= 80 ? 'bg-green-100 text-green-700' : pct >= 50 ? 'bg-amber-100 text-amber-700' : 'bg-red-100 text-red-700'
  return <span className={`rounded-full px-3 py-1 text-sm font-semibold ${tone}`}>{pct == null ? '—' : `${pct}%`} · {run.passed}/{run.total} passed</span>
}

// Compact latest-score badge on each suite card (the at-a-glance scorecard).
function SuiteScorePill({ run }: { run: Run }) {
  const pct = run.score != null ? Math.round(run.score * 100) : null
  const tone = pct == null ? 'bg-surface-2 text-muted' : pct >= 80 ? 'bg-green-100 text-green-700' : pct >= 50 ? 'bg-amber-100 text-amber-700' : 'bg-red-100 text-red-700'
  return (
    <span
      className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold ${tone}`}
      title={`${run.passed}/${run.total} passed · ${formatDate(run.created_at)}`}
    >
      {run.status === 'running' ? '…' : pct == null ? '—' : `${pct}%`}
    </span>
  )
}

// A compact run-history sparkline: each bar is a run (oldest left → newest right),
// height + colour by score%. Click a bar to inspect that run. Surfaces drift over
// time and model A/B (hover shows the `model` tag + cost) at a glance.
function TrendStrip({ runs, activeRun, onSelect }: { runs: Run[]; activeRun: string | null; onSelect: (id: string) => void }) {
  const ordered = [...runs].reverse()
  return (
    <div className="mb-6 rounded-xl border border-border bg-surface p-4">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs font-semibold text-text">Score trend</span>
        <span className="text-[11px] text-faint">last {ordered.length} run{ordered.length === 1 ? '' : 's'} · click a bar</span>
      </div>
      <div className="flex items-end gap-1" style={{ height: 64 }}>
        {ordered.map((r) => {
          const pct = r.score != null ? Math.round(r.score * 100) : 0
          const active = r.id === activeRun
          const tone = pct >= 80 ? 'bg-green-500' : pct >= 50 ? 'bg-amber-500' : 'bg-red-500'
          return (
            <button
              key={r.id}
              onClick={() => onSelect(r.id)}
              title={`${pct}% (${r.passed}/${r.total})${r.model ? ` · ${r.model}` : ''}${r.cost != null ? ` · $${r.cost.toFixed(4)}` : ''} · ${formatDate(r.created_at)}`}
              className={`min-w-[8px] flex-1 rounded-t transition ${tone} ${active ? 'ring-2 ring-primary ring-offset-1' : 'opacity-60 hover:opacity-100'}`}
              style={{ height: `${Math.max(6, pct)}%` }}
            />
          )
        })}
      </div>
    </div>
  )
}

function ResultRow({ result }: { result: Result }) {
  const [open, setOpen] = useState(false)
  const d = result.detail as unknown
  const assertions: AssertionResult[] = Array.isArray(d) ? (d as AssertionResult[]) : ((d as { assertions?: AssertionResult[] })?.assertions ?? [])
  const judge = Array.isArray(d) ? null : ((d as { judge?: Judge })?.judge ?? null)
  return (
    <div className="rounded-xl border border-border bg-surface p-3">
      <button onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-2 text-left">
        <span className={`text-sm ${result.passed ? 'text-green-600' : 'text-red-600'}`}>{result.passed ? '✓' : '✗'}</span>
        <span className="min-w-0 flex-1 truncate text-sm text-text">{result.case_name}</span>
        {result.score != null && <span className="text-xs text-faint">{Math.round(result.score * 100)}%</span>}
      </button>
      {open && (
        <div className="mt-2 space-y-2 border-t border-border pt-2">
          {judge && (
            <div className="rounded-lg bg-surface-2 p-2 text-xs">
              <span className={`font-semibold ${judge.pass ? 'text-green-600' : 'text-red-600'}`}>Judge: {judge.pass ? 'pass' : 'fail'} ({Math.round((judge.score ?? 0) * 100)}%)</span>
              {judge.reason && <span className="text-muted"> — {judge.reason}</span>}
            </div>
          )}
          {assertions.map((a, i) => (
            <div key={i} className="flex items-start gap-2 text-xs">
              <span className={a.pass ? 'text-green-600' : 'text-red-600'}>{a.pass ? '✓' : '✗'}</span>
              <span className="text-muted"><code className="rounded bg-surface-2 px-1">{a.type}</code> {a.detail}</span>
            </div>
          ))}
          {result.output && (
            <details className="mt-1" open={!!judge}>
              <summary className="cursor-pointer text-xs text-faint">{judge ? 'Generated answer' : 'Retrieved passages'}</summary>
              <pre className="mt-1 max-h-60 overflow-auto whitespace-pre-wrap rounded-lg bg-surface-2 p-2 text-[11px] text-muted">{result.output}</pre>
            </details>
          )}
        </div>
      )}
    </div>
  )
}

function CaseEditor({
  suiteId, judged, editingCase, onClose, onSaved,
}: {
  suiteId: string
  judged: boolean
  editingCase: Case | null
  onClose: () => void
  onSaved: () => void
}) {
  const [name, setName] = useState(editingCase?.name ?? '')
  const [input, setInput] = useState(editingCase?.input ?? '')
  const [expected, setExpected] = useState(editingCase?.expected ?? '')
  const [rows, setRows] = useState<AssertionRow[]>(editingCase ? toRows(editingCase.assertions) : [])
  const [saving, setSaving] = useState(false)

  function setRow(i: number, patch: Partial<AssertionRow>) {
    setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, ...patch } : r)))
  }

  async function save() {
    setSaving(true)
    const payload = { name: name.trim(), input: input.trim(), expected: expected.trim() || null, assertions: toStored(rows) }
    if (editingCase) await supabase.from('eval_cases').update(payload).eq('id', editingCase.id)
    else await supabase.from('eval_cases').insert({ suite_id: suiteId, ...payload })
    setSaving(false)
    onSaved()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/40 sm:items-center sm:p-4">
      <div className="flex max-h-[92vh] w-full max-w-lg flex-col overflow-hidden rounded-t-2xl bg-surface shadow-xl sm:rounded-2xl">
        <div className="flex items-center justify-between border-b border-border px-5 py-3">
          <h2 className="text-sm font-semibold text-text">{editingCase ? 'Edit case' : 'New case'}</h2>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto p-5">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted">Name (optional)</span>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Finds the Nightjar rollback codeword"
              className="w-full rounded-lg border border-border-strong px-3 py-2 text-sm outline-none focus:border-primary" />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted">{judged ? 'Question' : 'Input (the query sent to retrieval)'}</span>
            <textarea value={input} onChange={(e) => setInput(e.target.value)} rows={3}
              placeholder={judged ? 'e.g. What is the Project Nightjar rollback codeword and who owns the billing cutover?' : 'e.g. What is the Project Nightjar rollback codeword?'}
              className="w-full resize-y rounded-lg border border-border-strong px-3 py-2 text-sm leading-relaxed outline-none focus:border-primary" />
          </label>

          {judged && (
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-muted">Reference answer (a reasonable result — the judge grades against this)</span>
              <textarea value={expected} onChange={(e) => setExpected(e.target.value)} rows={3}
                placeholder="e.g. The rollback codeword is BLUE-OTTER-49 and Priya Raman owns the billing cutover (moved to Aug 13)."
                className="w-full resize-y rounded-lg border border-border-strong px-3 py-2 text-sm leading-relaxed outline-none focus:border-primary" />
            </label>
          )}

          <div>
            <div className="mb-1 flex items-center justify-between">
              <span className="text-xs font-medium text-muted">{judged ? 'Extra checks on the answer (optional)' : 'Assertions (all must pass)'}</span>
              <button onClick={() => setRows((rs) => [...rs, { type: judged ? 'contains' : 'retrieves', value: '', k: 5 }])} className="text-xs font-medium text-primary hover:underline">+ Add</button>
            </div>
            <div className="space-y-2">
              {rows.map((r, i) => {
                const meta = ASSERTION_TYPES.find((t) => t.value === r.type)
                return (
                  <div key={i} className="rounded-lg border border-border-strong p-2">
                    <div className="flex items-center gap-2">
                      <select value={r.type} onChange={(e) => setRow(i, { type: e.target.value })} className="rounded-md border border-border-strong bg-surface px-2 py-1.5 text-xs">
                        {ASSERTION_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                      </select>
                      {r.type === 'recall_at_k' && (
                        <input type="number" min={1} max={20} value={r.k} onChange={(e) => setRow(i, { k: Number(e.target.value) })} title="k"
                          className="w-14 rounded-md border border-border-strong px-2 py-1.5 text-xs" />
                      )}
                      <button onClick={() => setRows((rs) => rs.filter((_, idx) => idx !== i))} className="ml-auto rounded-md p-1 text-faint hover:text-red-600" title="Remove">
                        <TrashIcon className="h-3.5 w-3.5" />
                      </button>
                    </div>
                    <input value={r.value} onChange={(e) => setRow(i, { value: e.target.value })} placeholder={meta?.hint ?? 'value'}
                      className="mt-2 w-full rounded-md border border-border-strong px-2 py-1.5 text-xs outline-none focus:border-primary" />
                  </div>
                )
              })}
              {rows.length === 0 && <p className="text-xs text-faint">{judged ? 'None — the judge grades the answer. Add checks only if you want hard guards (e.g. must contain a specific string).' : 'Add at least one assertion.'}</p>}
            </div>
          </div>
        </div>

        <div className="flex justify-end gap-2 border-t border-border px-5 py-3">
          <button onClick={onClose} className="rounded-lg px-3 py-2 text-sm font-medium text-muted hover:bg-surface-hover">Cancel</button>
          <button onClick={save} disabled={saving || !input.trim()} className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white hover:bg-primary-strong disabled:opacity-50">
            {saving ? 'Saving…' : 'Save case'}
          </button>
        </div>
      </div>
    </div>
  )
}
