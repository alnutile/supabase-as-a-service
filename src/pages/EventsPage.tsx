import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import type { Database } from '../lib/database.types'
import { supabase } from '../lib/supabase'
import { formatDate } from '../lib/util'
import { PulseIcon } from '../components/icons'

type EventRow = Database['public']['Tables']['events']['Row']

// Event families. The key doubles as the `type` prefix we filter on.
const FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'message', label: 'Messages' },
  { key: 'collection', label: 'Collections' },
  { key: 'artifact', label: 'Artifacts' },
  { key: 'file', label: 'Files' },
  { key: 'todo', label: 'To-dos' },
  { key: 'link', label: 'Links' },
  { key: 'chat', label: 'Chat' },
] as const

type FilterKey = (typeof FILTERS)[number]['key']

function badgeStyle(type: string): string {
  if (type.startsWith('message')) return 'bg-primary-soft text-primary'
  if (type.startsWith('collection')) return 'bg-indigo-100 text-indigo-700'
  if (type.startsWith('artifact')) return 'bg-emerald-100 text-emerald-700'
  if (type.startsWith('file')) return 'bg-sky-100 text-sky-700'
  if (type.startsWith('todo')) return 'bg-amber-100 text-amber-700'
  if (type.startsWith('link')) return 'bg-violet-100 text-violet-700'
  return 'bg-surface-2 text-muted'
}

export default function EventsPage() {
  const [events, setEvents] = useState<EventRow[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<FilterKey>('all')
  const filterRef = useRef<FilterKey>(filter)
  filterRef.current = filter

  const load = useCallback(async () => {
    setLoading(true)
    let query = supabase.from('events').select('*').order('created_at', { ascending: false }).limit(150)
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
      .channel('events-feed')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'events' }, (payload) => {
        const row = payload.new as EventRow
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
        <div className="flex items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-text">Events</h1>
            <p className="mt-1 text-sm text-muted">
              The workspace’s automation stream — every record created, updated, or filed into a
              collection emits an event. Build automations on them with{' '}
              <Link to="/listeners" className="font-medium text-primary hover:underline">
                Listeners
              </Link>
              . Updates in real time.
            </p>
          </div>
        </div>

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
            <PulseIcon className="mx-auto mb-3 h-8 w-8 text-faint" />
            <p className="text-sm text-muted">Nothing yet. Events will show up here as things happen.</p>
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
                {ev.data != null && Object.keys(ev.data as object).length > 0 && (
                  <details className="mt-1.5">
                    <summary className="cursor-pointer text-xs text-faint">Details</summary>
                    <pre className="mt-1 overflow-x-auto rounded-lg bg-surface-2 p-2 text-[11px] text-muted">
                      {JSON.stringify(ev.data, null, 2)}
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
