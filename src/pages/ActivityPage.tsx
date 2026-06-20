import { useCallback, useEffect, useRef, useState } from 'react'
import type { Database } from '../lib/database.types'
import { supabase } from '../lib/supabase'
import { formatDate } from '../lib/util'
import { ActivityIcon } from '../components/icons'

type Activity = Database['public']['Tables']['activity_log']['Row']

// Event families. The key doubles as the `type` prefix we filter the query on
// (e.g. 'schedule' matches 'schedule.run' / 'schedule.error').
const FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'schedule', label: 'Schedules' },
  { key: 'webhook', label: 'Webhooks' },
  { key: 'tool', label: 'Tools' },
  { key: 'artifact', label: 'Artifacts' },
  { key: 'file', label: 'Files' },
  { key: 'guardrail', label: 'Guardrails' },
  { key: 'email', label: 'Email' },
  { key: 'feedback', label: 'Feedback' },
] as const

type FilterKey = (typeof FILTERS)[number]['key']

// Colour each event family so the feed is scannable at a glance.
function badgeStyle(type: string): string {
  if (type.startsWith('guardrail')) return type.endsWith('.flagged') ? 'bg-amber-100 text-amber-700' : 'bg-red-100 text-red-700'
  if (type.startsWith('feedback')) return type.endsWith('.down') ? 'bg-red-100 text-red-700' : 'bg-emerald-100 text-emerald-700'
  if (type.endsWith('.error')) return 'bg-red-100 text-red-700'
  if (type.startsWith('schedule')) return 'bg-violet-100 text-violet-700'
  if (type.startsWith('webhook')) return 'bg-amber-100 text-amber-700'
  if (type.startsWith('tool')) return 'bg-indigo-100 text-indigo-700'
  if (type.startsWith('artifact')) return 'bg-emerald-100 text-emerald-700'
  if (type.startsWith('file')) return 'bg-sky-100 text-sky-700'
  return 'bg-surface-2 text-muted'
}

export default function ActivityPage() {
  const [events, setEvents] = useState<Activity[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<FilterKey>('all')
  // Realtime handler closes over this so it can drop rows outside the filter
  // without re-subscribing on every filter change.
  const filterRef = useRef<FilterKey>(filter)
  filterRef.current = filter

  // Filter server-side (not just over the loaded page) so a rare event like a
  // daily schedule run isn't buried past the 150-row window.
  const load = useCallback(async () => {
    setLoading(true)
    let query = supabase
      .from('activity_log')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(150)
    if (filter !== 'all') query = query.like('type', `${filter}%`)
    const { data } = await query
    setEvents(data ?? [])
    setLoading(false)
  }, [filter])

  useEffect(() => {
    load()
  }, [load])

  useEffect(() => {
    const channel = supabase
      .channel('activity_log')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'activity_log' }, (payload) => {
        const row = payload.new as Activity
        const f = filterRef.current
        if (f !== 'all' && !row.type.startsWith(f)) return
        setEvents((prev) => [row, ...prev].slice(0, 200))
      })
      .subscribe()
    return () => {
      supabase.removeChannel(channel)
    }
  }, [])

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-2xl px-6 py-8">
        <h1 className="text-2xl font-semibold tracking-tight text-text">Activity</h1>
        <p className="mt-1 text-sm text-muted">
          A live feed of what’s happening across the workspace — scheduled runs, webhook events,
          tool calls, artifacts, uploads, and feedback. Updates in real time.
        </p>

        <div className="mt-4 flex flex-wrap gap-1.5">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              className={`rounded-full px-3 py-1 text-xs font-medium transition ${
                filter === f.key ? 'bg-slate-900 text-white' : 'bg-surface-2 text-muted hover:bg-surface-hover'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>

        {loading ? (
          <p className="mt-6 text-sm text-faint">Loading…</p>
        ) : events.length === 0 ? (
          <div className="mt-6 rounded-2xl border border-dashed border-border-strong py-16 text-center">
            <ActivityIcon className="mx-auto mb-3 h-8 w-8 text-faint" />
            <p className="text-sm text-muted">
              {filter === 'all'
                ? 'Nothing yet. Events will show up here as they happen.'
                : `No ${FILTERS.find((f) => f.key === filter)?.label.toLowerCase()} activity yet.`}
            </p>
          </div>
        ) : (
          <ol className="mt-6 space-y-2">
            {events.map((ev) => (
              <li key={ev.id} className="rounded-xl border border-border bg-surface p-3">
                <div className="flex items-center gap-2">
                  <span className={`rounded-full px-2 py-0.5 font-mono text-[10px] ${badgeStyle(ev.type)}`}>
                    {ev.type}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm text-text">{ev.summary}</span>
                  <span className="shrink-0 text-xs text-faint">{formatDate(ev.created_at)}</span>
                </div>
                {ev.detail != null && Object.keys(ev.detail as object).length > 0 && (
                  <details className="mt-1.5">
                    <summary className="cursor-pointer text-xs text-faint">Details</summary>
                    <pre className="mt-1 overflow-x-auto rounded-lg bg-surface-2 p-2 text-[11px] text-muted">
                      {JSON.stringify(ev.detail, null, 2)}
                    </pre>
                  </details>
                )}
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  )
}
