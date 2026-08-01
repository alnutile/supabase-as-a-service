import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import type { Database } from '../lib/database.types'
import { supabase } from '../lib/supabase'
import { timeAgo } from '../lib/dashboard'
import {
  formatCost,
  formatDuration,
  formatTokens,
  runDurationMs,
  statusTone,
  surfaceLabel,
  type Tone,
} from '../lib/agentRuns'
import { AgentIcon, ChatIcon, ChevronLeftIcon, PlayIcon, ToolIcon, SparkleIcon } from '../components/icons'

type Agent = Database['public']['Tables']['agents']['Row']
type Run = Database['public']['Tables']['agent_runs']['Row']
type Step = Database['public']['Tables']['agent_run_steps']['Row']
type Schedule = Database['public']['Tables']['schedules']['Row']

const TONE_CLASSES: Record<Tone, string> = {
  amber: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
  emerald: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  rose: 'bg-rose-500/10 text-rose-600 dark:text-rose-400',
  slate: 'bg-slate-500/10 text-slate-500',
}

function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${TONE_CLASSES[statusTone(status)]}`}>
      {status === 'running' && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" />}
      {status}
    </span>
  )
}

function JsonBlock({ value }: { value: unknown }) {
  const text = useMemo(() => {
    try {
      return typeof value === 'string' ? value : JSON.stringify(value, null, 2)
    } catch {
      return String(value)
    }
  }, [value])
  if (!text || text === '{}' || text === 'null') return null
  return (
    <pre className="mt-1 max-h-64 overflow-auto rounded-lg bg-surface-2 p-2 text-[11px] leading-relaxed text-muted">
      {text}
    </pre>
  )
}

// One step in a run's timeline. Advanced mode reveals raw tool input/output and
// per-step tokens; simple mode is a plain "did X" line for non-technical users.
function StepRow({ step, advanced }: { step: Step; advanced: boolean }) {
  const [open, setOpen] = useState(false)
  const isTool = step.kind === 'tool'
  const hasDetail = advanced && (step.input || step.output || step.error)

  return (
    <li className="relative pl-6">
      <span
        className={`absolute left-1.5 top-1.5 h-2 w-2 rounded-full ${
          step.error ? 'bg-rose-500' : isTool ? 'bg-primary' : 'bg-border-strong'
        }`}
      />
      <div className="rounded-lg border border-border bg-surface px-3 py-2">
        <button
          onClick={() => hasDetail && setOpen((o) => !o)}
          className={`flex w-full items-center gap-2 text-left ${hasDetail ? 'cursor-pointer' : 'cursor-default'}`}
        >
          {isTool ? <ToolIcon className="h-3.5 w-3.5 shrink-0 text-primary" /> : <SparkleIcon className="h-3.5 w-3.5 shrink-0 text-faint" />}
          <span className="min-w-0 flex-1 truncate text-xs font-medium text-text">
            {isTool ? step.tool_name || 'tool' : 'Model turn'}
            {step.sandboxed && <span className="ml-1.5 rounded bg-slate-500/10 px-1 text-[10px] text-slate-500">sandboxed</span>}
          </span>
          {step.error && <span className="shrink-0 text-[11px] text-rose-500">error</span>}
          {advanced && step.duration_ms != null && (
            <span className="shrink-0 text-[11px] text-faint">{formatDuration(step.duration_ms)}</span>
          )}
          {advanced && step.tokens != null && step.tokens > 0 && (
            <span className="shrink-0 text-[11px] text-faint">{formatTokens(step.tokens)} tok</span>
          )}
        </button>

        {/* Model text always shows a preview; tool detail is advanced + expand. */}
        {!isTool && step.output && (
          <p className={`mt-1 whitespace-pre-wrap text-xs text-muted ${open || advanced ? '' : 'line-clamp-2'}`}>{step.output}</p>
        )}
        {step.error && <p className="mt-1 text-xs text-rose-500">{step.error}</p>}
        {isTool && !advanced && step.output && <p className="mt-1 line-clamp-1 text-[11px] text-faint">{step.output}</p>}

        {hasDetail && open && (
          <div className="mt-1.5 border-t border-border pt-1.5">
            {isTool && step.input != null && (
              <>
                <p className="text-[10px] font-semibold uppercase tracking-wide text-faint">Input</p>
                <JsonBlock value={step.input} />
              </>
            )}
            {isTool && step.output && (
              <>
                <p className="mt-1 text-[10px] font-semibold uppercase tracking-wide text-faint">Output</p>
                <JsonBlock value={step.output} />
              </>
            )}
          </div>
        )}
      </div>
    </li>
  )
}

function RunCard({ run, advanced }: { run: Run; advanced: boolean }) {
  const [open, setOpen] = useState(false)
  const [steps, setSteps] = useState<Step[] | null>(null)

  const loadSteps = useCallback(async () => {
    const { data } = await supabase
      .from('agent_run_steps')
      .select('*')
      .eq('run_id', run.id)
      .order('seq', { ascending: true })
    setSteps(data ?? [])
  }, [run.id])

  useEffect(() => {
    if (!open) return
    loadSteps()
    // A running row's steps tick in live while it's expanded.
    if (run.status !== 'running') return
    const ch = supabase
      .channel(`run-steps-${run.id}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'agent_run_steps', filter: `run_id=eq.${run.id}` }, loadSteps)
      .subscribe()
    return () => {
      supabase.removeChannel(ch)
    }
  }, [open, run.status, run.id, loadSteps])

  const dur = runDurationMs(run)

  return (
    <div className="rounded-xl border border-border bg-surface">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-surface-hover"
      >
        <StatusBadge status={run.status} />
        <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[11px] text-muted">{surfaceLabel(run.surface)}</span>
        <span className="min-w-0 flex-1 truncate text-xs text-muted">{run.final_output || run.input || '—'}</span>
        <span className="hidden shrink-0 text-[11px] text-faint sm:inline">{run.tool_calls} tools</span>
        {advanced && <span className="hidden shrink-0 text-[11px] text-faint md:inline">{formatTokens(run.total_tokens)} tok</span>}
        {advanced && <span className="hidden shrink-0 text-[11px] text-faint md:inline">{formatCost(run.cost)}</span>}
        <span className="shrink-0 text-[11px] text-faint">{formatDuration(dur)}</span>
        <span className="shrink-0 text-[11px] text-faint" title={new Date(run.started_at).toLocaleString()}>
          {timeAgo(run.started_at)}
        </span>
      </button>

      {open && (
        <div className="border-t border-border px-4 py-3">
          {run.error && <p className="mb-2 rounded-lg bg-rose-500/10 px-3 py-2 text-xs text-rose-500">{run.error}</p>}
          {steps === null ? (
            <p className="text-xs text-faint">Loading steps…</p>
          ) : steps.length === 0 ? (
            <p className="text-xs text-faint">No steps recorded.</p>
          ) : (
            <ol className="space-y-2 border-l border-border">
              {steps.map((s) => (
                <StepRow key={s.id} step={s} advanced={advanced} />
              ))}
            </ol>
          )}
          {advanced && (
            <p className="mt-2 text-[11px] text-faint">
              Run {run.id} · {run.model || 'model n/a'} · {run.turns} turns
            </p>
          )}
        </div>
      )}
    </div>
  )
}

export default function AgentDetailPage() {
  const { agentId } = useParams<{ agentId: string }>()
  const navigate = useNavigate()
  const [agent, setAgent] = useState<Agent | null>(null)
  const [schedules, setSchedules] = useState<Schedule[]>([])
  const [runs, setRuns] = useState<Run[]>([])
  const [loading, setLoading] = useState(true)
  const [advanced, setAdvanced] = useState(false)
  const [showInstructions, setShowInstructions] = useState(false)

  const loadRuns = useCallback(async () => {
    if (!agentId) return
    const { data } = await supabase
      .from('agent_runs')
      .select('*')
      .eq('agent_id', agentId)
      .order('started_at', { ascending: false })
      .limit(50)
    setRuns(data ?? [])
  }, [agentId])

  useEffect(() => {
    if (!agentId) return
    let cancelled = false
    ;(async () => {
      const [{ data: a }, { data: s }] = await Promise.all([
        supabase.from('agents').select('*').eq('id', agentId).maybeSingle(),
        supabase.from('schedules').select('*').eq('agent_id', agentId),
      ])
      if (cancelled) return
      setAgent(a)
      setSchedules(s ?? [])
      await loadRuns()
      setLoading(false)
    })()
    return () => {
      cancelled = true
    }
  }, [agentId, loadRuns])

  // Live: a new/updated run row (any surface) refreshes the list.
  useEffect(() => {
    if (!agentId) return
    const ch = supabase
      .channel(`agent-runs-${agentId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'agent_runs', filter: `agent_id=eq.${agentId}` }, loadRuns)
      .subscribe()
    return () => {
      supabase.removeChannel(ch)
    }
  }, [agentId, loadRuns])

  if (loading) {
    return <div className="p-6 text-sm text-faint">Loading…</div>
  }
  if (!agent) {
    return (
      <div className="p-6">
        <button onClick={() => navigate('/agents')} className="text-sm text-primary hover:underline">
          ← Back to agents
        </button>
        <p className="mt-4 text-sm text-muted">Agent not found, or you don’t have access to it.</p>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-4xl p-4 sm:p-6">
      <button
        onClick={() => navigate('/agents')}
        className="mb-3 inline-flex items-center gap-1 text-sm text-muted hover:text-text"
      >
        <ChevronLeftIcon className="h-4 w-4" /> Agents
      </button>

      {/* Header + config summary */}
      <div className="rounded-2xl border border-border bg-surface p-4 sm:p-5">
        <div className="flex items-start gap-3">
          <AgentIcon className="mt-0.5 h-6 w-6 shrink-0 text-primary" />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h1 className="truncate text-lg font-semibold text-text">{agent.name}</h1>
              {agent.is_active ? (
                <span className="h-2 w-2 rounded-full bg-emerald-500" title="Active" />
              ) : (
                <span className="text-[10px] uppercase text-faint">off</span>
              )}
            </div>
            {agent.description && <p className="mt-0.5 text-sm text-muted">{agent.description}</p>}
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-faint">
              <span>{agent.tool_ids.length} tools</span>
              <span>{agent.collection_ids.length} collections</span>
              <span>{schedules.length} schedules</span>
            </div>
          </div>
          <div className="flex shrink-0 gap-2">
            <button
              onClick={() => navigate(`/chat?agent=${agent.id}&run=1`)}
              className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-white hover:bg-primary-strong"
            >
              <PlayIcon className="h-3.5 w-3.5" /> Run
            </button>
            <button
              onClick={() => navigate(`/chat?agent=${agent.id}`)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border-strong px-3 py-1.5 text-xs font-medium text-muted hover:bg-surface-hover"
            >
              <ChatIcon className="h-3.5 w-3.5" /> Chat
            </button>
          </div>
        </div>
        {agent.instructions && (
          <div className="mt-3 border-t border-border pt-3">
            <button
              onClick={() => setShowInstructions((v) => !v)}
              className="text-[11px] font-semibold uppercase tracking-wide text-faint hover:text-muted"
            >
              {showInstructions ? 'Hide' : 'Show'} instructions
            </button>
            {showInstructions && (
              <p className="mt-1.5 whitespace-pre-wrap text-xs text-muted">{agent.instructions}</p>
            )}
          </div>
        )}
      </div>

      {/* Runs */}
      <div className="mt-5 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-text">Runs</h2>
        <label className="flex cursor-pointer items-center gap-2 text-xs text-muted">
          <span>Technical detail</span>
          <button
            role="switch"
            aria-checked={advanced}
            onClick={() => setAdvanced((v) => !v)}
            className={`relative h-5 w-9 rounded-full transition ${advanced ? 'bg-primary' : 'bg-border-strong'}`}
          >
            <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition ${advanced ? 'left-[18px]' : 'left-0.5'}`} />
          </button>
        </label>
      </div>

      <div className="mt-3 space-y-2">
        {runs.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-border-strong py-12 text-center">
            <p className="text-sm text-muted">No runs yet.</p>
            <p className="mt-1 text-xs text-faint">
              Runs appear here when this agent fires — from chat, a schedule, a webhook, or Slack.
            </p>
          </div>
        ) : (
          runs.map((r) => <RunCard key={r.id} run={r} advanced={advanced} />)
        )}
      </div>
    </div>
  )
}
