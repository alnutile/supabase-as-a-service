import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { ThumbsDownIcon, ThumbsUpIcon } from '../components/icons'

// Shape returned by the feedback_summary(p_days) RPC.
interface CategoryRow { category: string; count: number }
interface RecentRow {
  id: string
  rating: 'up' | 'down'
  category: string | null
  note: string | null
  agent_id: string | null
  email: string | null
  created_at: string
}
interface Summary {
  days: number
  total: number
  up: number
  down: number
  by_category: CategoryRow[]
  recent: RecentRow[]
}

const RANGES = [
  { days: 7, label: '7 days' },
  { days: 30, label: '30 days' },
  { days: 90, label: '90 days' },
] as const

const CATEGORY_LABELS: Record<string, string> = {
  off_target: 'Off target',
  needs_work: 'Needs work',
  exactly_right: 'Exactly right',
  '(none)': 'No category',
}
const label = (c: string) => CATEGORY_LABELS[c] ?? c

const num = (n: number | null | undefined) => (n == null ? '—' : n.toLocaleString())
const fmtDate = (s: string) => new Date(s).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })

export default function FeedbackPage() {
  const [days, setDays] = useState<number>(30)
  const [summary, setSummary] = useState<Summary | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (d: number) => {
    setLoading(true)
    setError(null)
    const { data, error: rpcErr } = await supabase.rpc('feedback_summary', { p_days: d })
    if (rpcErr) setError(rpcErr.message)
    else setSummary(data as unknown as Summary)
    setLoading(false)
  }, [])

  useEffect(() => {
    load(days)
  }, [days, load])

  const satisfaction =
    summary && summary.total > 0 ? Math.round((summary.up / summary.total) * 100) : null

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-4xl px-6 py-8">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-text">Feedback</h1>
            <p className="mt-1 text-sm text-muted">
              What the team is telling the assistant — the seed for evaluation.
            </p>
          </div>
          <div className="flex shrink-0 rounded-lg border border-border bg-surface p-0.5">
            {RANGES.map((r) => (
              <button
                key={r.days}
                onClick={() => setDays(r.days)}
                className={`rounded-md px-2.5 py-1 text-xs font-medium ${
                  days === r.days ? 'bg-primary text-white' : 'text-muted hover:bg-surface-hover'
                }`}
              >
                {r.label}
              </button>
            ))}
          </div>
        </div>

        {error && (
          <div className="mt-6 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
            {error.includes('admin') ? 'Feedback is admin-only.' : error}
          </div>
        )}

        {/* Totals */}
        <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label={`Ratings (last ${days}d)`} value={num(summary?.total)} />
          <Stat label="👍 Positive" value={num(summary?.up)} />
          <Stat label="👎 Needs work" value={num(summary?.down)} />
          <Stat label="Satisfaction" value={satisfaction == null ? '—' : `${satisfaction}%`} />
        </div>

        {/* By category */}
        {summary && summary.by_category.length > 0 && (
          <section className="mt-4 rounded-xl border border-border bg-surface p-5">
            <h2 className="text-sm font-semibold text-text">By category</h2>
            <div className="mt-3 flex flex-wrap gap-2">
              {summary.by_category.map((c) => (
                <span
                  key={c.category}
                  className="flex items-center gap-1.5 rounded-full border border-border bg-surface-2 px-2.5 py-1 text-xs text-text"
                >
                  {label(c.category)}
                  <span className="rounded-full bg-primary-soft px-1.5 text-[11px] font-semibold text-primary">
                    {c.count}
                  </span>
                </span>
              ))}
            </div>
          </section>
        )}

        {/* Recent feedback */}
        <section className="mt-4 rounded-xl border border-border bg-surface p-5">
          <h2 className="text-sm font-semibold text-text">Recent feedback</h2>
          <div className="mt-3 divide-y divide-border">
            {(summary?.recent ?? []).map((r) => (
              <div key={r.id} className="flex items-start gap-3 py-3">
                <span className="mt-0.5 shrink-0">
                  {r.rating === 'up' ? (
                    <ThumbsUpIcon className="h-4 w-4 text-primary" />
                  ) : (
                    <ThumbsDownIcon className="h-4 w-4 text-red-600" />
                  )}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    {r.category && (
                      <span className="rounded-full border border-border px-2 py-0.5 text-[11px] text-muted">
                        {label(r.category)}
                      </span>
                    )}
                    {r.agent_id && (
                      <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[11px] text-amber-700">
                        agent
                      </span>
                    )}
                    <span className="text-xs text-faint">{r.email ?? '(unknown)'}</span>
                    <span className="text-xs text-faint">· {fmtDate(r.created_at)}</span>
                  </div>
                  {r.note && <p className="mt-1 text-sm text-text">{r.note}</p>}
                </div>
              </div>
            ))}
          </div>
          {loading && <p className="mt-2 text-sm text-faint">Loading…</p>}
          {!loading && summary && summary.recent.length === 0 && (
            <p className="mt-2 text-sm text-faint">No feedback in this window yet.</p>
          )}
        </section>
      </div>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-border bg-surface p-4">
      <div className="text-xs font-medium text-muted">{label}</div>
      <div className="mt-1 text-lg font-semibold text-text">{value}</div>
    </div>
  )
}
