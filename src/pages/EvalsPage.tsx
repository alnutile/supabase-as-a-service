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

// One assertion as edited in the UI. Stored on the case as
// {type, doc|text|pattern, k?} — value maps to the field the type uses.
type AssertionRow = { type: string; value: string; k: number }
type StoredAssertion = { type: string; doc?: string; text?: string; pattern?: string; k?: number }
type AssertionResult = { type: string; pass: boolean; detail: string }

const ASSERTION_TYPES = [
  { value: 'retrieves', label: 'Retrieves document', hint: 'a document whose name contains…' },
  { value: 'recall_at_k', label: 'Retrieves in top-k', hint: 'document name contains… within top k' },
  { value: 'contains', label: 'Passages contain', hint: 'the retrieved text contains…' },
  { value: 'not_contains', label: "Passages don't contain", hint: 'the retrieved text must NOT contain…' },
  { value: 'regex', label: 'Passages match regex', hint: 'a regular expression' },
]

function valueField(type: string): 'doc' | 'text' | 'pattern' {
  if (type === 'retrieves' || type === 'recall_at_k') return 'doc'
  if (type === 'regex') return 'pattern'
  return 'text'
}

function toRows(assertions: unknown): AssertionRow[] {
  const arr = Array.isArray(assertions) ? (assertions as StoredAssertion[]) : []
  return arr.map((a) => ({
    type: a.type ?? 'retrieves',
    value: String(a.doc ?? a.text ?? a.pattern ?? ''),
    k: Number(a.k ?? 5),
  }))
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
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<Suite | null>(null)

  const load = useCallback(async () => {
    const { data } = await supabase.from('eval_suites').select('*').order('updated_at', { ascending: false })
    setSuites(data ?? [])
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

  async function createSuite() {
    const { data } = await supabase
      .from('eval_suites')
      .insert({ name: 'New eval suite', target_kind: 'rag' })
      .select()
      .single()
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

  if (selected) {
    return (
      <SuiteDetail
        suite={selected}
        onBack={() => {
          setSelected(null)
          load()
        }}
      />
    )
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl px-6 py-8">
        <div className="mb-1 flex items-center justify-between">
          <h1 className="text-2xl font-semibold tracking-tight text-text">Evals</h1>
          <button
            onClick={createSuite}
            className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white hover:bg-primary-strong"
          >
            <PlusIcon className="h-4 w-4" /> New suite
          </button>
        </div>
        <p className="mb-6 text-sm text-muted">
          Measure whether the AI gives good answers — and catch regressions when you change the model or
          a prompt. A <strong>suite</strong> holds <strong>cases</strong> (an input + assertions about the
          result); running it scores them. Today's suites test <strong>retrieval</strong> (does{' '}
          <code className="rounded bg-surface-2 px-1">search_documents</code> find the right passages?) —
          deterministic, no judge model.
        </p>

        {loading ? (
          <p className="text-sm text-faint">Loading…</p>
        ) : suites.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border-strong p-8 text-center text-sm text-muted">
            No eval suites yet. Create one, add a few cases (e.g. a question whose answer lives in a known
            document), and run it to get a retrieval score.
          </div>
        ) : (
          <div className="space-y-3">
            {suites.map((s) => (
              <button
                key={s.id}
                onClick={() => setSelected(s)}
                className="flex w-full items-center gap-3 rounded-xl border border-border bg-surface p-4 text-left hover:border-border-strong"
              >
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-muted">
                  <EvalIcon className="h-5 w-5" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium text-text">{s.name}</span>
                    <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted">
                      {s.target_kind}
                    </span>
                  </div>
                  <p className="mt-0.5 line-clamp-1 text-xs text-muted">
                    {s.description || 'No description'} · {formatDate(s.updated_at)}
                  </p>
                </div>
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
  const [cases, setCases] = useState<Case[]>([])
  const [runs, setRuns] = useState<Run[]>([])
  const [activeRun, setActiveRun] = useState<string | null>(null)
  const [results, setResults] = useState<Result[]>([])
  const [editing, setEditing] = useState<Case | 'new' | null>(null)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState('')

  const loadCases = useCallback(async () => {
    const { data } = await supabase.from('eval_cases').select('*').eq('suite_id', suite.id).order('created_at')
    setCases(data ?? [])
  }, [suite.id])

  const loadRuns = useCallback(async () => {
    const { data } = await supabase
      .from('eval_runs')
      .select('*')
      .eq('suite_id', suite.id)
      .order('created_at', { ascending: false })
      .limit(20)
    setRuns(data ?? [])
    setActiveRun((prev) => prev ?? data?.[0]?.id ?? null)
  }, [suite.id])

  useEffect(() => {
    loadCases()
    loadRuns()
  }, [loadCases, loadRuns])

  useEffect(() => {
    if (!activeRun) {
      setResults([])
      return
    }
    supabase
      .from('eval_results')
      .select('*')
      .eq('run_id', activeRun)
      .order('created_at')
      .then(({ data }) => setResults(data ?? []))
  }, [activeRun])

  async function saveSuiteMeta() {
    await supabase
      .from('eval_suites')
      .update({ name, description, updated_at: new Date().toISOString() })
      .eq('id', suite.id)
  }

  async function deleteCase(c: Case) {
    if (!confirm('Delete this case?')) return
    await supabase.from('eval_cases').delete().eq('id', c.id)
    loadCases()
  }

  async function run() {
    setRunning(true)
    setError('')
    const { data, error: invokeErr } = await supabase.functions.invoke('evals', { body: { suite_id: suite.id } })
    if (invokeErr) {
      let msg = invokeErr.message
      // FunctionsHttpError carries the response; surface our JSON {error}.
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const j = await (invokeErr as any).context.json()
        if (j?.error) msg = j.error
      } catch {
        // keep the generic message
      }
      setError(msg)
    } else if (data?.error) {
      setError(data.error)
    } else {
      const newRunId = data?.run_id ?? null
      await loadRuns()
      if (newRunId) setActiveRun(newRunId)
    }
    setRunning(false)
  }

  const current = runs.find((r) => r.id === activeRun) ?? null

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl px-6 py-8">
        <button onClick={onBack} className="mb-4 text-sm text-muted hover:text-text">
          ← All suites
        </button>

        {/* Suite header / settings */}
        <div className="mb-6 rounded-xl border border-border bg-surface p-4">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={saveSuiteMeta}
            className="w-full bg-transparent text-xl font-semibold tracking-tight text-text outline-none"
          />
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            onBlur={saveSuiteMeta}
            placeholder="Optional description"
            className="mt-1 w-full bg-transparent text-sm text-muted outline-none"
          />
          <div className="mt-3 flex items-center gap-3">
            <button
              onClick={run}
              disabled={running || cases.length === 0}
              className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white hover:bg-primary-strong disabled:opacity-50"
            >
              <PlayIcon className="h-4 w-4" /> {running ? 'Running…' : 'Run suite'}
            </button>
            <span className="text-xs text-faint">
              {cases.length} case{cases.length === 1 ? '' : 's'} · target {suite.target_kind}
            </span>
          </div>
          {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
        </div>

        {/* Latest / selected run */}
        {current && (
          <div className="mb-6">
            <div className="mb-2 flex items-center gap-3">
              <ScoreBadge run={current} />
              <span className="text-xs text-faint">
                {formatDate(current.created_at)}
                {current.model ? ` · model ${current.model}` : ''}
                {current.status === 'error' ? ' · errored' : ''}
              </span>
              {runs.length > 1 && (
                <select
                  value={activeRun ?? ''}
                  onChange={(e) => setActiveRun(e.target.value)}
                  className="ml-auto rounded-md border border-border-strong bg-surface px-2 py-1 text-xs"
                >
                  {runs.map((r) => (
                    <option key={r.id} value={r.id}>
                      {formatDate(r.created_at)} — {r.passed}/{r.total}
                    </option>
                  ))}
                </select>
              )}
            </div>
            <div className="space-y-2">
              {results.map((res) => (
                <ResultRow key={res.id} result={res} />
              ))}
            </div>
          </div>
        )}

        {/* Cases */}
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-text">Cases</h2>
          <button
            onClick={() => setEditing('new')}
            className="flex items-center gap-1.5 rounded-lg border border-border-strong px-3 py-1.5 text-xs font-medium text-muted hover:bg-surface-hover"
          >
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
                    “{c.input}” · {n} assertion{n === 1 ? '' : 's'}
                  </p>
                </button>
                <button
                  onClick={() => deleteCase(c)}
                  className="rounded-md p-1.5 text-faint hover:bg-red-50 hover:text-red-600"
                  title="Delete"
                >
                  <TrashIcon className="h-4 w-4" />
                </button>
              </div>
            )
          })}
          {cases.length === 0 && (
            <p className="rounded-xl border border-dashed border-border-strong p-6 text-center text-xs text-muted">
              No cases yet. Add one: an input (the question/query) plus assertions about what should come back.
            </p>
          )}
        </div>
      </div>

      {editing && (
        <CaseEditor
          suiteId={suite.id}
          editingCase={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null)
            loadCases()
          }}
        />
      )}
    </div>
  )
}

function ScoreBadge({ run }: { run: Run }) {
  const pct = run.score != null ? Math.round(run.score * 100) : null
  const tone =
    pct == null ? 'bg-surface-2 text-muted' : pct >= 80 ? 'bg-green-100 text-green-700' : pct >= 50 ? 'bg-amber-100 text-amber-700' : 'bg-red-100 text-red-700'
  return (
    <span className={`rounded-full px-3 py-1 text-sm font-semibold ${tone}`}>
      {pct == null ? '—' : `${pct}%`} · {run.passed}/{run.total} passed
    </span>
  )
}

function ResultRow({ result }: { result: Result }) {
  const [open, setOpen] = useState(false)
  const detail = (Array.isArray(result.detail) ? result.detail : []) as AssertionResult[]
  return (
    <div className="rounded-xl border border-border bg-surface p-3">
      <button onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-2 text-left">
        <span className={`text-sm ${result.passed ? 'text-green-600' : 'text-red-600'}`}>
          {result.passed ? '✓' : '✗'}
        </span>
        <span className="min-w-0 flex-1 truncate text-sm text-text">{result.case_name}</span>
        {result.score != null && (
          <span className="text-xs text-faint">{Math.round(result.score * 100)}%</span>
        )}
      </button>
      {open && (
        <div className="mt-2 space-y-1 border-t border-border pt-2">
          {detail.map((d, i) => (
            <div key={i} className="flex items-start gap-2 text-xs">
              <span className={d.pass ? 'text-green-600' : 'text-red-600'}>{d.pass ? '✓' : '✗'}</span>
              <span className="text-muted">
                <code className="rounded bg-surface-2 px-1">{d.type}</code> {d.detail}
              </span>
            </div>
          ))}
          {result.output && (
            <details className="mt-1">
              <summary className="cursor-pointer text-xs text-faint">Retrieved passages</summary>
              <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded-lg bg-surface-2 p-2 text-[11px] text-muted">
                {result.output}
              </pre>
            </details>
          )}
        </div>
      )}
    </div>
  )
}

function CaseEditor({
  suiteId,
  editingCase,
  onClose,
  onSaved,
}: {
  suiteId: string
  editingCase: Case | null
  onClose: () => void
  onSaved: () => void
}) {
  const [name, setName] = useState(editingCase?.name ?? '')
  const [input, setInput] = useState(editingCase?.input ?? '')
  const [rows, setRows] = useState<AssertionRow[]>(
    editingCase ? toRows(editingCase.assertions) : [{ type: 'retrieves', value: '', k: 5 }],
  )
  const [saving, setSaving] = useState(false)

  function setRow(i: number, patch: Partial<AssertionRow>) {
    setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, ...patch } : r)))
  }

  async function save() {
    setSaving(true)
    const payload = { name: name.trim(), input: input.trim(), assertions: toStored(rows) }
    if (editingCase) {
      await supabase.from('eval_cases').update(payload).eq('id', editingCase.id)
    } else {
      await supabase.from('eval_cases').insert({ suite_id: suiteId, ...payload })
    }
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
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Finds the Nightjar rollback codeword"
              className="w-full rounded-lg border border-border-strong px-3 py-2 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary-soft"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted">Input (the query sent to retrieval)</span>
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              rows={3}
              placeholder="e.g. What is the Project Nightjar rollback codeword?"
              className="w-full resize-y rounded-lg border border-border-strong px-3 py-2 text-sm leading-relaxed outline-none focus:border-primary focus:ring-2 focus:ring-primary-soft"
            />
          </label>

          <div>
            <div className="mb-1 flex items-center justify-between">
              <span className="text-xs font-medium text-muted">Assertions (all must pass)</span>
              <button
                onClick={() => setRows((rs) => [...rs, { type: 'retrieves', value: '', k: 5 }])}
                className="text-xs font-medium text-primary hover:underline"
              >
                + Add
              </button>
            </div>
            <div className="space-y-2">
              {rows.map((r, i) => {
                const meta = ASSERTION_TYPES.find((t) => t.value === r.type)
                return (
                  <div key={i} className="rounded-lg border border-border-strong p-2">
                    <div className="flex items-center gap-2">
                      <select
                        value={r.type}
                        onChange={(e) => setRow(i, { type: e.target.value })}
                        className="rounded-md border border-border-strong bg-surface px-2 py-1.5 text-xs"
                      >
                        {ASSERTION_TYPES.map((t) => (
                          <option key={t.value} value={t.value}>
                            {t.label}
                          </option>
                        ))}
                      </select>
                      {r.type === 'recall_at_k' && (
                        <input
                          type="number"
                          min={1}
                          max={20}
                          value={r.k}
                          onChange={(e) => setRow(i, { k: Number(e.target.value) })}
                          title="k"
                          className="w-14 rounded-md border border-border-strong px-2 py-1.5 text-xs"
                        />
                      )}
                      <button
                        onClick={() => setRows((rs) => rs.filter((_, idx) => idx !== i))}
                        className="ml-auto rounded-md p-1 text-faint hover:text-red-600"
                        title="Remove"
                      >
                        <TrashIcon className="h-3.5 w-3.5" />
                      </button>
                    </div>
                    <input
                      value={r.value}
                      onChange={(e) => setRow(i, { value: e.target.value })}
                      placeholder={meta?.hint ?? 'value'}
                      className="mt-2 w-full rounded-md border border-border-strong px-2 py-1.5 text-xs outline-none focus:border-primary"
                    />
                  </div>
                )
              })}
            </div>
          </div>
        </div>

        <div className="flex justify-end gap-2 border-t border-border px-5 py-3">
          <button onClick={onClose} className="rounded-lg px-3 py-2 text-sm font-medium text-muted hover:bg-surface-hover">
            Cancel
          </button>
          <button
            onClick={save}
            disabled={saving || !input.trim()}
            className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white hover:bg-primary-strong disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save case'}
          </button>
        </div>
      </div>
    </div>
  )
}
