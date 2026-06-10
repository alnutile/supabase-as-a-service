import { useCallback, useEffect, useState } from 'react'
import type { Database } from '../lib/database.types'
import { supabase } from '../lib/supabase'
import { formatDate } from '../lib/util'
import { ActivityIcon } from '../components/icons'

type Activity = Database['public']['Tables']['activity_log']['Row']

// Colour each event family so the feed is scannable at a glance.
function badgeStyle(type: string): string {
  if (type.endsWith('.error')) return 'bg-red-100 text-red-700'
  if (type.startsWith('webhook')) return 'bg-amber-100 text-amber-700'
  if (type.startsWith('tool')) return 'bg-indigo-100 text-indigo-700'
  if (type.startsWith('artifact')) return 'bg-emerald-100 text-emerald-700'
  if (type.startsWith('file')) return 'bg-sky-100 text-sky-700'
  return 'bg-slate-100 text-slate-600'
}

export default function ActivityPage() {
  const [events, setEvents] = useState<Activity[]>([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    const { data } = await supabase
      .from('activity_log')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(150)
    setEvents(data ?? [])
    setLoading(false)
  }, [])

  useEffect(() => {
    load()
    const channel = supabase
      .channel('activity_log')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'activity_log' }, (payload) =>
        setEvents((prev) => [payload.new as Activity, ...prev].slice(0, 200)),
      )
      .subscribe()
    return () => {
      supabase.removeChannel(channel)
    }
  }, [load])

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-2xl px-6 py-8">
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900">Activity</h1>
        <p className="mt-1 text-sm text-slate-500">
          A live feed of what’s happening across the workspace — webhook events, tool calls,
          artifacts, and uploads. Updates in real time.
        </p>

        {loading ? (
          <p className="mt-6 text-sm text-slate-400">Loading…</p>
        ) : events.length === 0 ? (
          <div className="mt-6 rounded-2xl border border-dashed border-slate-300 py-16 text-center">
            <ActivityIcon className="mx-auto mb-3 h-8 w-8 text-slate-300" />
            <p className="text-sm text-slate-500">Nothing yet. Events will show up here as they happen.</p>
          </div>
        ) : (
          <ol className="mt-6 space-y-2">
            {events.map((ev) => (
              <li key={ev.id} className="rounded-xl border border-slate-200 bg-white p-3">
                <div className="flex items-center gap-2">
                  <span className={`rounded-full px-2 py-0.5 font-mono text-[10px] ${badgeStyle(ev.type)}`}>
                    {ev.type}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm text-slate-700">{ev.summary}</span>
                  <span className="shrink-0 text-xs text-slate-400">{formatDate(ev.created_at)}</span>
                </div>
                {ev.detail != null && Object.keys(ev.detail as object).length > 0 && (
                  <details className="mt-1.5">
                    <summary className="cursor-pointer text-xs text-slate-400">Details</summary>
                    <pre className="mt-1 overflow-x-auto rounded-lg bg-slate-50 p-2 text-[11px] text-slate-600">
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
