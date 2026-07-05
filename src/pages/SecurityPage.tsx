import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import { formatDate } from '../lib/util'
import { LockIcon, RadarIcon, SparkleIcon } from '../components/icons'

// Governance → Security: the workspace posture scan as a dashboard. "Run scan"
// invokes the run_security_scan builtin through the universal run-tool function
// (no bespoke endpoint); findings land in security_findings and render here.
// Each open finding can be dismissed (accepted risk — the status carries over
// on future runs) or PROMOTED onto the Features board in the idea lane, where
// the normal human-approval drag pipeline gets it built. A daily run is just an
// agent scoped to the run_security_scan tool with a schedule — see the hint in
// the header.

interface Scan {
  id: string
  status: 'running' | 'ok' | 'error'
  summary: string
  findings_count: number
  error: string | null
  started_at: string
  finished_at: string | null
}

interface Finding {
  id: string
  scan_id: string
  key: string
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info'
  title: string
  detail: string
  suggestion: string
  status: 'open' | 'dismissed' | 'promoted'
  feature_id: string | null
  created_at: string
}

const SEVERITY_STYLE: Record<Finding['severity'], string> = {
  critical: 'bg-red-100 text-red-700',
  high: 'bg-red-50 text-red-600',
  medium: 'bg-amber-100 text-amber-700',
  low: 'bg-sky-100 text-sky-700',
  info: 'bg-surface-2 text-muted',
}

async function runScan(): Promise<string> {
  const { data: sess } = await supabase.auth.getSession()
  const token = sess.session?.access_token
  const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/run-tool`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
    },
    body: JSON.stringify({ tool: 'run_security_scan', input: {} }),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body.error ?? `Scan failed (${res.status})`)
  return String(body.result ?? '')
}

export default function SecurityPage() {
  const { user } = useAuth()
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null)
  const [scans, setScans] = useState<Scan[]>([])
  const [findings, setFindings] = useState<Finding[]>([])
  const [running, setRunning] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [showTriaged, setShowTriaged] = useState(false)

  useEffect(() => {
    if (!user) return
    supabase
      .from('profiles')
      .select('is_admin')
      .eq('id', user.id)
      .maybeSingle()
      .then(({ data }) => setIsAdmin(Boolean(data?.is_admin)))
  }, [user])

  const load = useCallback(async () => {
    const { data: scanRows } = await supabase
      .from('security_scans')
      .select('*')
      .order('started_at', { ascending: false })
      .limit(10)
    const list = (scanRows as unknown as Scan[]) ?? []
    setScans(list)
    const latestOk = list.find((s) => s.status === 'ok')
    if (latestOk) {
      const { data: rows } = await supabase
        .from('security_findings')
        .select('*')
        .eq('scan_id', latestOk.id)
        .order('created_at', { ascending: true })
      setFindings((rows as unknown as Finding[]) ?? [])
    } else {
      setFindings([])
    }
  }, [])

  useEffect(() => {
    if (isAdmin) load()
  }, [isAdmin, load])

  async function onRun() {
    setRunning(true)
    setNotice(null)
    try {
      await runScan()
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'The scan failed.')
    }
    setRunning(false)
    load()
  }

  async function dismiss(f: Finding) {
    await supabase.from('security_findings').update({ status: 'dismissed', updated_at: new Date().toISOString() }).eq('id', f.id)
    load()
  }

  async function reopen(f: Finding) {
    await supabase.from('security_findings').update({ status: 'open', updated_at: new Date().toISOString() }).eq('id', f.id)
    load()
  }

  // Promote: file the finding on the Features board (idea lane). From there
  // the existing approval drags take over — this button never spends AI effort
  // or touches GitHub by itself.
  async function promote(f: Finding) {
    if (!user) return
    setNotice(null)
    const { data: feature, error } = await supabase
      .from('features')
      .insert({
        title: f.title,
        description: `${f.detail}\n\nSuggested fix: ${f.suggestion}\n\n(Filed from the Security dashboard, finding ${f.key}.)`,
        lane: 'idea',
        owner_id: user.id,
      })
      .select('id')
      .single()
    if (error || !feature) {
      setNotice(error?.message ?? 'Could not create the feature.')
      return
    }
    await supabase
      .from('security_findings')
      .update({ status: 'promoted', feature_id: feature.id, updated_at: new Date().toISOString() })
      .eq('id', f.id)
    load()
  }

  if (isAdmin === false) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-faint">
        <LockIcon className="h-10 w-10" />
        <p className="max-w-sm text-sm">The security dashboard is managed by workspace admins.</p>
      </div>
    )
  }
  if (isAdmin === null) return null

  const latest = scans[0]
  const open = findings.filter((f) => f.status === 'open')
  const triaged = findings.filter((f) => f.status !== 'open')

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl px-6 py-8">
        <div className="mb-1 flex items-center justify-between">
          <h1 className="text-2xl font-semibold tracking-tight text-text">Security</h1>
          <button
            onClick={onRun}
            disabled={running}
            className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white hover:bg-primary-strong disabled:opacity-50"
          >
            <RadarIcon className="h-4 w-4" /> {running ? 'Scanning…' : 'Run scan'}
          </button>
        </div>
        <p className="mb-6 text-sm text-muted">
          Deterministic checks over the workspace's configuration — webhooks, guardrails, tools,
          secrets, sharing. Dismiss a finding to accept the risk (it stays dismissed on future
          runs), or promote it to the <strong>Features board</strong> to get it fixed through the
          normal review pipeline. To run this daily, create an agent with only the{' '}
          <code className="rounded bg-surface-2 px-1">run_security_scan</code> tool and give it a
          schedule.
        </p>

        {notice && (
          <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">
            {notice}
          </div>
        )}

        {latest ? (
          <div className="mb-6 rounded-xl border border-border bg-surface p-4">
            <div className="flex items-center gap-2 text-sm">
              <span
                className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                  latest.status === 'ok'
                    ? 'bg-emerald-100 text-emerald-700'
                    : latest.status === 'error'
                      ? 'bg-red-100 text-red-700'
                      : 'bg-amber-100 text-amber-700'
                }`}
              >
                {latest.status === 'ok' ? 'completed' : latest.status}
              </span>
              <span className="text-muted">Last scan {formatDate(latest.started_at)}</span>
              <span className="ml-auto text-faint">{scans.length} recent run{scans.length === 1 ? '' : 's'}</span>
            </div>
            <p className="mt-2 text-sm text-text">{latest.error ?? latest.summary}</p>
          </div>
        ) : (
          <p className="mb-6 rounded-xl border border-dashed border-border px-6 py-10 text-center text-sm text-faint">
            No scans yet. Run the first one to see where the workspace stands.
          </p>
        )}

        {open.length > 0 && (
          <h2 className="mb-2 text-sm font-semibold text-text">
            Open findings <span className="text-faint">({open.length})</span>
          </h2>
        )}
        <div className="space-y-3">
          {open.map((f) => (
            <div key={f.id} className="rounded-xl border border-border bg-surface p-4">
              <div className="flex items-center gap-2">
                <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${SEVERITY_STYLE[f.severity]}`}>
                  {f.severity}
                </span>
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-text">{f.title}</span>
              </div>
              <p className="mt-2 text-sm text-muted">{f.detail}</p>
              <p className="mt-2 text-sm text-text">
                <span className="font-semibold">Fix:</span> {f.suggestion}
              </p>
              <div className="mt-3 flex gap-2">
                <button
                  onClick={() => promote(f)}
                  className="flex items-center gap-1.5 rounded-lg bg-primary-soft px-3 py-1.5 text-xs font-semibold text-primary hover:bg-primary-soft/70"
                >
                  <SparkleIcon className="h-3.5 w-3.5" /> Promote to feature
                </button>
                <button
                  onClick={() => dismiss(f)}
                  className="rounded-lg px-3 py-1.5 text-xs font-medium text-muted hover:bg-surface-hover"
                >
                  Dismiss
                </button>
              </div>
            </div>
          ))}
          {latest?.status === 'ok' && open.length === 0 && (
            <p className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
              No open findings — everything the scan checks looks good.
            </p>
          )}
        </div>

        {triaged.length > 0 && (
          <div className="mt-6">
            <button
              onClick={() => setShowTriaged((v) => !v)}
              className="mb-2 text-sm font-semibold text-muted hover:text-text"
            >
              {showTriaged ? 'Hide' : 'Show'} triaged ({triaged.length})
            </button>
            {showTriaged && (
              <div className="space-y-2">
                {triaged.map((f) => (
                  <div key={f.id} className="flex items-center gap-2 rounded-xl border border-border bg-surface-2/50 px-4 py-2.5 text-sm">
                    <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${SEVERITY_STYLE[f.severity]}`}>
                      {f.severity}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-muted">{f.title}</span>
                    {f.status === 'promoted' && f.feature_id ? (
                      <a href="/features" className="rounded-full bg-primary-soft px-2 py-0.5 text-[11px] font-medium text-primary">
                        on the board
                      </a>
                    ) : (
                      <span className="text-[11px] text-faint">{f.status}</span>
                    )}
                    <button onClick={() => reopen(f)} className="text-[11px] font-medium text-muted hover:text-text">
                      Reopen
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
