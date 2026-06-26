import { useCallback, useEffect, useState } from 'react'
import type { Database } from '../lib/database.types'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import { formatDate } from '../lib/util'
import { CopyIcon, LoopIcon, PlayIcon, PlusIcon, TrashIcon } from '../components/icons'

type Loop = Database['public']['Tables']['loops']['Row']
type LoopRun = Database['public']['Tables']['loop_runs']['Row']
type Agent = Database['public']['Tables']['agents']['Row']
type Tool = Database['public']['Tables']['tools']['Row']

interface TranscriptEntry {
  iteration: number
  score: number | null
  detail: string
  cost_spent: number
  preview: string
  tools_used?: string[]
}

const STOP_LABEL: Record<string, string> = {
  budget: 'Stopped at price cap',
  max_iterations: 'Reached iteration limit',
  converged: 'Agent converged',
  target_reached: 'Hit target score',
  error: 'Errored',
}

export default function LoopsPage() {
  const { user } = useAuth()
  const [loops, setLoops] = useState<Loop[]>([])
  const [agents, setAgents] = useState<Agent[]>([])
  const [tools, setTools] = useState<Tool[]>([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<Loop | null>(null)
  const [running, setRunning] = useState<Loop | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    const [{ data: l, error: le }, { data: a }, { data: t }] = await Promise.all([
      supabase.from('loops').select('*').order('updated_at', { ascending: false }),
      supabase.from('agents').select('*').eq('is_active', true).order('name'),
      supabase.from('tools').select('*').eq('is_active', true).eq('kind', 'http'),
    ])
    // A failed loops read almost always means the 0031 migration hasn't been
    // applied — surface it instead of silently showing an empty list.
    if (le) setError(`Couldn't load loops: ${le.message}. The 0031_loops migration may not be applied to this project.`)
    setLoops(l ?? [])
    setAgents(a ?? [])
    setTools(t ?? [])
    setLoading(false)
  }, [])

  useEffect(() => {
    load()
  }, [load])

  async function create() {
    if (!agents.length) return
    setError(null)
    const { data, error: ce } = await supabase
      .from('loops')
      .insert({ owner_id: user!.id, name: 'New loop', agent_id: agents[0].id, goal: '' })
      .select()
      .single()
    if (ce) {
      setError(`Couldn't create a loop: ${ce.message}`)
      return
    }
    if (data) {
      await load()
      setEditing(data)
    }
  }

  const agentName = (id: string) => agents.find((a) => a.id === id)?.name ?? 'missing agent'

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl px-6 py-8">
        <div className="mb-1 flex items-center justify-between">
          <h1 className="text-2xl font-semibold tracking-tight text-text">Loops</h1>
          <button
            onClick={create}
            disabled={!agents.length}
            className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white hover:bg-primary-strong disabled:opacity-50"
          >
            <PlusIcon className="h-4 w-4" /> New loop
          </button>
        </div>
        <p className="mb-6 text-sm text-muted">
          A loop runs an agent toward a goal over and over — each round its candidate is scored, the
          score feeds the next round, and the best result is kept. It stops when the agent converges,
          hits the iteration limit, reaches a target score, or <strong>spends up to its price cap</strong>.
        </p>

        {error && (
          <div className="mb-4 flex items-start justify-between gap-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
            <span>{error}</span>
            <button onClick={() => setError(null)} className="shrink-0 font-medium hover:text-red-900">
              Dismiss
            </button>
          </div>
        )}

        {loading ? (
          <p className="text-sm text-faint">Loading…</p>
        ) : !agents.length ? (
          <div className="rounded-2xl border border-dashed border-border-strong py-16 text-center">
            <LoopIcon className="mx-auto mb-3 h-8 w-8 text-faint" />
            <p className="text-sm text-muted">
              Create an <a href="/agents" className="text-primary underline">agent</a> first — a loop runs an agent toward a goal.
            </p>
          </div>
        ) : loops.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-border-strong py-16 text-center">
            <LoopIcon className="mx-auto mb-3 h-8 w-8 text-faint" />
            <p className="text-sm text-muted">No loops yet. Create one to get started.</p>
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {loops.map((l) => (
              <div key={l.id} className="flex flex-col rounded-xl border border-border bg-surface p-4">
                <div className="flex items-center gap-2">
                  <LoopIcon className="h-5 w-5 shrink-0 text-primary" />
                  <span className="min-w-0 flex-1 truncate font-medium text-text">{l.name}</span>
                  {!l.is_active && <span className="text-[10px] uppercase text-faint">off</span>}
                </div>
                <p className="mt-1 line-clamp-2 text-xs text-muted">{l.goal || 'No goal set yet'}</p>
                <p className="mt-2 text-[11px] text-faint">
                  {agentName(l.agent_id)} · ≤{l.max_iterations} iters · ${Number(l.budget_usd).toFixed(2)} cap
                  {l.target_score != null ? ` · target ${l.target_score}` : ''}
                </p>
                <p className="mt-0.5 text-[11px] text-faint">{formatDate(l.updated_at)}</p>
                <div className="mt-3 flex gap-2">
                  <button
                    onClick={() => setRunning(l)}
                    disabled={!l.is_active || !l.goal.trim()}
                    title={!l.goal.trim() ? 'Set a goal first' : 'Run this loop now'}
                    className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-white hover:bg-primary-strong disabled:opacity-50"
                  >
                    <PlayIcon className="h-3.5 w-3.5" /> Run
                  </button>
                  <button
                    onClick={() => setEditing(l)}
                    className="rounded-lg border border-border-strong px-3 py-1.5 text-xs font-medium text-muted hover:bg-surface-hover"
                  >
                    Edit
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {editing && (
        <LoopEditor
          loop={editing}
          agents={agents}
          tools={tools}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null)
            load()
          }}
        />
      )}
      {running && <RunView loop={running} onClose={() => setRunning(null)} />}
    </div>
  )
}

function LoopEditor({
  loop,
  agents,
  tools,
  onClose,
  onSaved,
}: {
  loop: Loop
  agents: Agent[]
  tools: Tool[]
  onClose: () => void
  onSaved: () => void
}) {
  const [name, setName] = useState(loop.name)
  const [goal, setGoal] = useState(loop.goal)
  const [agentId, setAgentId] = useState(loop.agent_id)
  const [feedbackToolId, setFeedbackToolId] = useState<string | null>(loop.feedback_tool_id)
  const [rubric, setRubric] = useState(loop.rubric)
  const [maxIterations, setMaxIterations] = useState(loop.max_iterations)
  const [budget, setBudget] = useState(String(loop.budget_usd))
  const [targetScore, setTargetScore] = useState<string>(loop.target_score == null ? '' : String(loop.target_score))
  const [isActive, setIsActive] = useState(loop.is_active)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function save() {
    setSaving(true)
    setErr(null)
    const budgetNum = Math.max(0.01, Number(budget) || 1)
    const target = targetScore.trim() === '' ? null : Math.max(0, Math.min(100, Number(targetScore)))
    const { error } = await supabase
      .from('loops')
      .update({
        name,
        goal,
        agent_id: agentId,
        feedback_tool_id: feedbackToolId,
        rubric,
        max_iterations: Math.max(1, Math.min(50, maxIterations)),
        budget_usd: budgetNum,
        target_score: target,
        is_active: isActive,
        updated_at: new Date().toISOString(),
      })
      .eq('id', loop.id)
    setSaving(false)
    if (error) {
      setErr(`Couldn't save: ${error.message}`)
      return
    }
    onSaved()
  }

  async function remove() {
    if (!confirm(`Delete loop “${loop.name}”?`)) return
    const { error } = await supabase.from('loops').delete().eq('id', loop.id)
    if (error) {
      setErr(`Couldn't delete: ${error.message}`)
      return
    }
    onSaved()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/40 sm:items-center sm:p-4">
      <div className="flex max-h-[92vh] w-full max-w-lg flex-col overflow-hidden rounded-t-2xl bg-surface shadow-xl sm:rounded-2xl">
        <div className="flex items-center justify-between border-b border-border px-5 py-3">
          <h2 className="text-sm font-semibold text-text">Loop</h2>
          <button onClick={remove} className="rounded-md p-1.5 text-faint hover:bg-red-50 hover:text-red-600" title="Delete">
            <TrashIcon className="h-[18px] w-[18px]" />
          </button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto p-5">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted">Name</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full rounded-lg border border-border-strong px-3 py-2 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary-soft"
            />
          </label>

          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted">Goal — what a good result looks like</span>
            <textarea
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              rows={3}
              placeholder="Write a tight, engaging 200-word blog intro about why small teams should adopt AI agents."
              className="w-full resize-y rounded-lg border border-border-strong px-3 py-2 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary-soft"
            />
          </label>

          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted">Agent that does the work</span>
            <select
              value={agentId}
              onChange={(e) => setAgentId(e.target.value)}
              className="w-full rounded-lg border border-border-strong px-3 py-2 text-sm"
            >
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted">How candidates are scored</span>
            <select
              value={feedbackToolId ?? ''}
              onChange={(e) => setFeedbackToolId(e.target.value || null)}
              className="w-full rounded-lg border border-border-strong px-3 py-2 text-sm"
            >
              <option value="">Built-in judge (AI grades 0–100 against the rubric)</option>
              {tools.map((t) => (
                <option key={t.id} value={t.id}>
                  Tool: {t.name} (returns a score)
                </option>
              ))}
            </select>
          </label>

          {!feedbackToolId && (
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-muted">Scoring rubric (optional)</span>
              <textarea
                value={rubric}
                onChange={(e) => setRubric(e.target.value)}
                rows={2}
                placeholder="Reward a strong hook, concrete specifics, and a clear call to action. Penalize fluff and clichés."
                className="w-full resize-y rounded-lg border border-border-strong px-3 py-2 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary-soft"
              />
            </label>
          )}

          <div className="grid grid-cols-3 gap-3">
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-muted">Max iterations</span>
              <input
                type="number"
                min={1}
                max={50}
                value={maxIterations}
                onChange={(e) => setMaxIterations(Number(e.target.value))}
                className="w-full rounded-lg border border-border-strong px-3 py-2 text-sm outline-none focus:border-primary"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-muted">Price cap ($)</span>
              <input
                type="number"
                min={0.01}
                step={0.05}
                value={budget}
                onChange={(e) => setBudget(e.target.value)}
                className="w-full rounded-lg border border-border-strong px-3 py-2 text-sm outline-none focus:border-primary"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-muted">Target (opt.)</span>
              <input
                type="number"
                min={0}
                max={100}
                value={targetScore}
                onChange={(e) => setTargetScore(e.target.value)}
                placeholder="90"
                className="w-full rounded-lg border border-border-strong px-3 py-2 text-sm outline-none focus:border-primary"
              />
            </label>
          </div>

          <label className="flex items-center gap-2 text-sm text-text">
            <input
              type="checkbox"
              checked={isActive}
              onChange={(e) => setIsActive(e.target.checked)}
              className="h-4 w-4 rounded border-border-strong text-primary focus:ring-brand-500"
            />
            Active
          </label>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-3">
          {err && <span className="mr-auto text-xs text-red-600">{err}</span>}
          <button onClick={onClose} className="rounded-lg px-3 py-2 text-sm font-medium text-muted hover:bg-surface-hover">
            Cancel
          </button>
          <button
            onClick={save}
            disabled={saving || !name.trim()}
            className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white hover:bg-primary-strong disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}

function RunView({ loop, onClose }: { loop: Loop; onClose: () => void }) {
  const [run, setRun] = useState<LoopRun | null>(null)
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const budget = Number(loop.budget_usd)

  // Live updates: subscribe to this loop's runs. The edge function inserts a run
  // row at start and updates it each iteration, so progress streams in.
  useEffect(() => {
    const channel = supabase
      .channel(`loop_runs:${loop.id}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'loop_runs', filter: `loop_id=eq.${loop.id}` },
        (payload) => {
          const row = payload.new as LoopRun
          setRun((cur) => (!cur || cur.id === row.id || new Date(row.started_at) >= new Date(cur.started_at) ? row : cur))
        },
      )
      .subscribe()
    return () => {
      supabase.removeChannel(channel)
    }
  }, [loop.id])

  async function start() {
    setStarting(true)
    setError(null)
    setRun(null)
    const { data, error: invokeErr } = await supabase.functions.invoke('loop', { body: { loop_id: loop.id } })
    setStarting(false)
    if (invokeErr) {
      // FunctionsHttpError hides the real cause in a Response body ("non-2xx
      // status code") — read it so the actual error shows.
      let msg = invokeErr.message
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ctx = (invokeErr as any).context
      if (ctx && typeof ctx.text === 'function') {
        try {
          const body = await ctx.text()
          const parsed = body && body.trim().startsWith('{') ? JSON.parse(body) : null
          msg = parsed?.error || body || msg
        } catch {
          // keep the generic message
        }
      }
      setError(msg)
      return
    }
    if (data?.error) setError(data.error)
    // Final state arrives via realtime; refetch as a fallback.
    if (data?.run_id) {
      const { data: r } = await supabase.from('loop_runs').select('*').eq('id', data.run_id).maybeSingle()
      if (r) setRun(r)
    }
  }

  const transcript: TranscriptEntry[] = Array.isArray(run?.transcript) ? (run!.transcript as unknown as TranscriptEntry[]) : []
  const spent = run ? Number(run.cost_spent) : 0
  const pct = Math.min(100, budget > 0 ? (spent / budget) * 100 : 0)
  const isRunning = run?.status === 'running' || starting

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/40 sm:items-center sm:p-4">
      <div className="flex max-h-[92vh] w-full max-w-2xl flex-col overflow-hidden rounded-t-2xl bg-surface shadow-xl sm:rounded-2xl">
        <div className="flex items-center justify-between border-b border-border px-5 py-3">
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold text-text">{loop.name}</h2>
            <p className="truncate text-xs text-muted">{loop.goal}</p>
          </div>
          <button onClick={onClose} className="ml-3 rounded-md px-2 py-1 text-sm text-muted hover:bg-surface-hover">
            Close
          </button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto p-5">
          {/* Cost vs. budget meter — the price cap, live. */}
          <div>
            <div className="mb-1 flex items-center justify-between text-xs">
              <span className="font-medium text-muted">
                Spend ${spent.toFixed(4)} / ${budget.toFixed(2)} cap
              </span>
              {run && (
                <span className="text-faint">
                  {run.iterations} iter{run.iterations === 1 ? '' : 's'}
                  {run.best_score != null ? ` · best ${run.best_score}/100` : ''}
                </span>
              )}
            </div>
            <div className="h-2 w-full overflow-hidden rounded-full bg-surface-2">
              <div
                className={`h-full rounded-full transition-all ${pct >= 90 ? 'bg-red-500' : pct >= 70 ? 'bg-amber-500' : 'bg-emerald-500'}`}
                style={{ width: `${pct}%` }}
              />
            </div>
          </div>

          {error && <div className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{error}</div>}

          {run?.status === 'done' && run.stop_reason && (
            <div className="rounded-lg border border-border bg-surface-2 px-3 py-2 text-xs text-muted">
              <strong className="text-text">{STOP_LABEL[run.stop_reason] ?? run.stop_reason}</strong>
              {' · '}best {run.best_score ?? 'n/a'}{run.best_score != null ? '/100' : ''} · ${spent.toFixed(4)} spent
            </div>
          )}

          {/* Iteration transcript */}
          {transcript.length > 0 && (
            <div className="space-y-2">
              <span className="text-xs font-medium text-muted">Iterations</span>
              {transcript.map((t) => (
                <div key={t.iteration} className="rounded-lg border border-border p-3">
                  <div className="mb-1 flex items-center gap-2">
                    <span className="text-xs font-semibold text-text">#{t.iteration}</span>
                    {t.score != null && (
                      <span className="rounded-full bg-primary-soft px-2 py-0.5 text-[11px] font-semibold text-primary">
                        {t.score}/100
                      </span>
                    )}
                    {t.tools_used && t.tools_used.length > 0 && (
                      <span className="text-[10px] text-faint">used: {t.tools_used.join(', ')}</span>
                    )}
                    <span className="ml-auto text-[10px] text-faint">${Number(t.cost_spent).toFixed(4)}</span>
                  </div>
                  {t.detail && <p className="mb-1 text-[11px] italic text-muted">{t.detail}</p>}
                  <p className="line-clamp-3 whitespace-pre-wrap text-xs text-text">{t.preview}</p>
                </div>
              ))}
            </div>
          )}

          {isRunning && (
            <p className="animate-pulse text-center text-xs text-faint">
              Running… proposing, scoring, refining. This stops at the iteration or price cap.
            </p>
          )}

          {/* Best result */}
          {run?.best_output && (
            <div>
              <div className="mb-1 flex items-center justify-between">
                <span className="text-xs font-medium text-muted">Best result {run.best_score != null ? `(${run.best_score}/100)` : ''}</span>
                <button
                  onClick={() => navigator.clipboard.writeText(run.best_output ?? '')}
                  className="flex items-center gap-1 text-[11px] text-muted hover:text-text"
                >
                  <CopyIcon className="h-3.5 w-3.5" /> Copy
                </button>
              </div>
              <div className="max-h-60 overflow-y-auto whitespace-pre-wrap rounded-lg border border-border bg-surface-2 p-3 text-xs text-text">
                {run.best_output}
              </div>
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-border px-5 py-3">
          <span className="text-[11px] text-faint">
            Stops at: converge · {loop.max_iterations} iters · ${budget.toFixed(2)} cap
            {loop.target_score != null ? ` · ${loop.target_score}/100 target` : ''}
          </span>
          <button
            onClick={start}
            disabled={isRunning}
            className="flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white hover:bg-primary-strong disabled:opacity-50"
          >
            <PlayIcon className="h-4 w-4" /> {isRunning ? 'Running…' : run ? 'Run again' : 'Run loop'}
          </button>
        </div>
      </div>
    </div>
  )
}
