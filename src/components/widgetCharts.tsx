// Dependency-free SVG charts for dashboard widgets.
//
// Deliberately no chart library (matches the app's no-heavy-deps ethos — the
// Home trend chart and the card canvas are both hand-rolled). Each component
// takes an already-bucketed series and draws it; the widget owns the query +
// bucketing (src/lib/widgets.ts). Everything is a single accent (primary) with
// an opacity ramp so it reads in light + dark without a separate palette.

export type Bucket = { key: string; label: string; count: number }

const CHART_H = 110

// ── Time series (bar / line / area), last N days ────────────────────────────
export function SeriesChart({ buckets, viz }: { buckets: Bucket[]; viz: 'bar' | 'line' | 'area' }) {
  const max = Math.max(1, ...buckets.map((b) => b.count))

  if (viz === 'bar') {
    return (
      <div className="flex items-end gap-[3px]" style={{ height: CHART_H }}>
        {buckets.map((b, i) => {
          const h = b.count === 0 ? 3 : Math.max(6, Math.round((b.count / max) * 100))
          const label = i === 0 || i === buckets.length - 1
          return (
            <div key={b.key} className="group/bar flex flex-1 flex-col items-center justify-end">
              <div
                title={`${b.count} on ${b.key}`}
                className={`w-full rounded-t-[5px] transition-all ${
                  b.count === 0 ? 'bg-surface-2' : 'bg-primary/80 group-hover/bar:bg-primary'
                }`}
                style={{ height: `${h}px` }}
              />
              {label && <span className="mt-1.5 text-[10px] font-medium text-faint">{b.label}</span>}
            </div>
          )
        })}
      </div>
    )
  }

  // line / area — a stretched SVG path over the buckets.
  const n = buckets.length
  const W = 100
  const H = 40
  const pad = 2
  const x = (i: number) => (n <= 1 ? W / 2 : pad + (i * (W - pad * 2)) / (n - 1))
  const y = (v: number) => H - pad - (v / max) * (H - pad * 2)
  const line = buckets.map((b, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(2)},${y(b.count).toFixed(2)}`).join(' ')
  const area = `${line} L${x(n - 1).toFixed(2)},${H} L${x(0).toFixed(2)},${H} Z`

  return (
    <div className="text-primary" style={{ height: CHART_H }}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-full w-full">
        {viz === 'area' && <path d={area} fill="currentColor" opacity={0.14} />}
        <path d={line} fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="mt-1.5 flex justify-between text-[10px] font-medium text-faint">
        <span>{buckets[0]?.label}</span>
        <span>{buckets[n - 1]?.label}</span>
      </div>
    </div>
  )
}

// ── Categorical (grouped) — horizontal bars or a donut ──────────────────────
// Opacity ramp so N categories are distinguishable on the single accent.
function rampOpacity(i: number, n: number): number {
  if (n <= 1) return 1
  return 1 - (i / (n - 1)) * 0.72
}

export function CategoryChart({ buckets, viz }: { buckets: Bucket[]; viz: 'bar' | 'donut' }) {
  const total = buckets.reduce((s, b) => s + b.count, 0)
  if (total === 0) return <div className="py-8 text-center text-sm text-faint">Nothing to show.</div>

  if (viz === 'donut') {
    const R = 16
    const C = 2 * Math.PI * R
    let acc = 0
    return (
      <div className="flex items-center gap-4">
        <svg viewBox="0 0 40 40" className="h-[110px] w-[110px] shrink-0 -rotate-90 text-primary">
          <circle cx={20} cy={20} r={R} fill="none" stroke="currentColor" strokeWidth={7} className="text-surface-2" />
          {buckets.map((b, i) => {
            const frac = b.count / total
            const dash = `${(frac * C).toFixed(2)} ${(C - frac * C).toFixed(2)}`
            const offset = -acc * C
            acc += frac
            return (
              <circle
                key={b.key}
                cx={20}
                cy={20}
                r={R}
                fill="none"
                stroke="currentColor"
                strokeWidth={7}
                strokeDasharray={dash}
                strokeDashoffset={offset.toFixed(2)}
                opacity={rampOpacity(i, buckets.length)}
              >
                <title>{`${b.label}: ${b.count}`}</title>
              </circle>
            )
          })}
        </svg>
        <ul className="min-w-0 flex-1 space-y-1">
          {buckets.map((b, i) => (
            <li key={b.key} className="flex items-center gap-2 text-[12px]">
              <span className="h-2.5 w-2.5 shrink-0 rounded-sm bg-primary" style={{ opacity: rampOpacity(i, buckets.length) }} />
              <span className="min-w-0 flex-1 truncate text-text">{b.label}</span>
              <span className="shrink-0 font-semibold text-faint">{b.count}</span>
            </li>
          ))}
        </ul>
      </div>
    )
  }

  // horizontal bars — better than vertical for text category labels.
  const max = Math.max(1, ...buckets.map((b) => b.count))
  return (
    <ul className="space-y-2">
      {buckets.map((b, i) => (
        <li key={b.key} className="flex items-center gap-2.5">
          <span className="w-24 shrink-0 truncate text-[12px] text-muted" title={b.label}>{b.label}</span>
          <span className="relative h-4 flex-1 overflow-hidden rounded-md bg-surface-2">
            <span
              className="absolute inset-y-0 left-0 rounded-md bg-primary"
              style={{ width: `${Math.max(4, Math.round((b.count / max) * 100))}%`, opacity: rampOpacity(i, buckets.length) }}
            />
          </span>
          <span className="w-6 shrink-0 text-right text-[12px] font-semibold text-faint">{b.count}</span>
        </li>
      ))}
    </ul>
  )
}
