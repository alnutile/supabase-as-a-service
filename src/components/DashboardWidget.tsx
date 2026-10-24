import { useEffect, useMemo, useState } from 'react'
import type { Database } from '../lib/database.types'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import { bucketByDay, timeAgo } from '../lib/dashboard'
import {
  CHART_DAYS,
  WIDGET_SOURCES,
  bucketByCategory,
  clampWidgetLimit,
  describeWidget,
  isWidgetKind,
  isWidgetSource,
  normalizeSpec,
  windowStartISO,
  type WidgetSource,
} from '../lib/widgets'
import { CategoryChart, SeriesChart } from './widgetCharts'
import { CloseIcon } from './icons'

type WidgetRow = Database['public']['Tables']['dashboard_widgets']['Row']
type Row = Record<string, unknown>

// A single dashboard widget: runs its own query with the ordinary (RLS-scoped)
// client and renders one of three ways. RLS is the security boundary — a stored
// spec can only ever read rows the viewer may already see.
export function DashboardWidget({
  widget,
  onRemove,
}: {
  widget: WidgetRow
  onRemove: (id: string) => void
}) {
  const { user } = useAuth()
  const [count, setCount] = useState<number | null>(null)
  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(true)

  const kind = isWidgetKind(widget.kind) ? widget.kind : null
  const source = isWidgetSource(widget.source) ? (widget.source as WidgetSource) : null
  const spec = useMemo(
    () => (source ? normalizeSpec(source, widget.spec) : {}),
    [source, widget.spec],
  )

  useEffect(() => {
    if (!kind || !source || !user) {
      setLoading(false)
      return
    }
    let alive = true
    const def = WIDGET_SOURCES[source]
    // Dynamic table/column names don't fit the client's per-table generics, so
    // build these through an untyped handle. RLS still applies — this only
    // relaxes compile-time typing, never the security boundary.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const from = (table: string): any => (supabase as any).from(table)
    // Shared filters: mine (owner=me) and todo status.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const withFilters = (q: any): any => {
      let out = q
      if (spec.mine) out = out.eq(def.ownerField, user.id)
      if (spec.status && def.supportsStatus) out = out.eq('done', spec.status === 'done')
      return out
    }

    async function run() {
      setLoading(true)
      if (kind === 'stat') {
        let q = withFilters(from(def.table).select('id', { count: 'exact', head: true }))
        const start = windowStartISO(spec.window)
        if (start) q = q.gte(def.timeField, start)
        const { count: c } = await q
        if (alive) setCount(c ?? 0)
      } else if (kind === 'list') {
        const cols = [def.titleField, def.subtitleField, def.timeField].filter(Boolean).join(', ')
        let q = withFilters(from(def.table).select(`id, ${cols}`))
        const start = windowStartISO(spec.window)
        if (start) q = q.gte(def.timeField, start)
        const { data } = await q
          .order(def.timeField, { ascending: false })
          .limit(clampWidgetLimit(spec.limit))
        if (alive) setRows((data ?? []) as Row[])
      } else if (spec.groupBy) {
        // grouped chart — count rows per category value (allow-listed field, so
        // the column name is always ours, never free-form). Window filter still
        // applies; bucketing happens client-side in bucketByCategory.
        let q = withFilters(from(def.table).select(spec.groupBy))
        const start = windowStartISO(spec.window)
        if (start) q = q.gte(def.timeField, start)
        const { data } = await q.limit(2000)
        if (alive) setRows((data ?? []) as Row[])
      } else {
        // time-series chart — per-day over the last CHART_DAYS, plus filters.
        const since = new Date()
        since.setDate(since.getDate() - (CHART_DAYS - 1))
        since.setHours(0, 0, 0, 0)
        const q = withFilters(from(def.table).select(def.timeField))
        const { data } = await q.gte(def.timeField, since.toISOString()).limit(2000)
        if (alive) {
          setRows(((data ?? []) as Row[]).map((r) => ({ created_at: String(r[def.timeField] ?? '') })))
        }
      }
      if (alive) setLoading(false)
    }
    void run()
    return () => {
      alive = false
    }
  }, [kind, source, user, spec])

  const def = source ? WIDGET_SOURCES[source] : null
  const viz = spec.viz ?? 'bar'
  const dayBuckets = useMemo(() => bucketByDay(rows as { created_at: string }[], CHART_DAYS), [rows])
  const catBuckets = useMemo(
    () => (source && spec.groupBy ? bucketByCategory(source, spec.groupBy, rows) : []),
    [source, spec.groupBy, rows],
  )

  const RemoveButton = (
    <button
      onClick={() => onRemove(widget.id)}
      title="Remove widget"
      className="absolute right-3 top-3 rounded-lg p-1 text-faint opacity-0 transition hover:bg-surface-2 hover:text-text group-hover:opacity-100"
    >
      <CloseIcon className="h-3.5 w-3.5" />
    </button>
  )

  if (!kind || !source || !def) {
    return (
      <div className="group relative rounded-[18px] border border-dashed border-border-strong bg-surface p-5 shadow-soft">
        {RemoveButton}
        <div className="text-sm text-faint">Unsupported widget.</div>
      </div>
    )
  }

  // ── stat ──
  if (kind === 'stat') {
    return (
      <div
        className="group relative flex flex-col rounded-[18px] border border-border bg-surface p-5 shadow-soft"
        title={describeWidget('stat', source, spec)}
      >
        {RemoveButton}
        <span className="pr-6 text-[12px] font-bold uppercase tracking-[0.06em] text-faint">{widget.title}</span>
        <div className="mt-2 text-[34px] font-extrabold leading-none tracking-tight text-text">
          {loading || count === null ? <span className="text-faint">—</span> : count.toLocaleString()}
        </div>
        <div className="mt-3 text-[11px] font-semibold text-faint">{describeWidget('stat', source, spec)}</div>
      </div>
    )
  }

  // ── chart ──
  if (kind === 'chart') {
    const grouped = !!spec.groupBy
    const seriesViz = viz === 'donut' ? 'bar' : viz // donut only valid when grouped
    const total = (grouped ? catBuckets : dayBuckets).reduce((s, b) => s + b.count, 0)
    const subtitle = grouped ? describeWidget('chart', source, spec) : `${def.label} · last ${CHART_DAYS} days`
    return (
      <div className="group relative rounded-[18px] border border-border bg-surface p-6 shadow-soft">
        {RemoveButton}
        <div className="mb-5 flex items-end justify-between">
          <div className="min-w-0 pr-6">
            <div className="truncate text-[15px] font-bold tracking-tight text-text">{widget.title}</div>
            <div className="mt-0.5 text-[12px] font-medium text-faint">{subtitle}</div>
          </div>
          <div className="text-right">
            <div className="text-[24px] font-extrabold leading-none tracking-tight text-text">{total}</div>
            <div className="mt-1 text-[11px] font-semibold text-faint">total</div>
          </div>
        </div>
        {loading ? (
          <div className="h-[110px] animate-pulse rounded-xl bg-surface-2" />
        ) : grouped ? (
          <CategoryChart buckets={catBuckets} viz={viz === 'donut' ? 'donut' : 'bar'} />
        ) : (
          <SeriesChart buckets={dayBuckets} viz={seriesViz} />
        )}
      </div>
    )
  }

  // ── list ──
  return (
    <div className="group relative rounded-[18px] border border-border bg-surface p-6 shadow-soft">
      {RemoveButton}
      <div className="mb-3 min-w-0 pr-6">
        <div className="truncate text-[15px] font-bold tracking-tight text-text">{widget.title}</div>
        <div className="mt-0.5 text-[12px] font-medium text-faint">{describeWidget('list', source, spec)}</div>
      </div>
      {loading ? (
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-8 animate-pulse rounded-lg bg-surface-2" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <div className="py-6 text-center text-sm text-faint">Nothing to show.</div>
      ) : (
        <ul className="space-y-0.5">
          {rows.map((r) => {
            const title = String(r[def.titleField] ?? '').trim() || '(untitled)'
            const sub = def.subtitleField ? String(r[def.subtitleField] ?? '').trim() : ''
            const ts = String(r[def.timeField] ?? '')
            return (
              <li
                key={String(r.id)}
                className="flex items-center gap-3 rounded-xl px-2 py-1.5 transition hover:bg-surface-2"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm text-text">{title}</div>
                  {sub && <div className="truncate text-[11px] text-faint">{sub}</div>}
                </div>
                {ts && <span className="shrink-0 text-[11px] font-medium text-faint">{timeAgo(ts)}</span>}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
