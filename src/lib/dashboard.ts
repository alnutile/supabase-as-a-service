// Pure helpers for the Home dashboard ("what's going on" overview).
//
// Kept out of HomePage on purpose (see CLAUDE.md: extract pure logic, test the
// module). The page does the Supabase I/O and rendering; everything that's a
// calculation — day-bucketing activity for the trend chart, completion math,
// relative timestamps, and mapping an activity type to a scannable family +
// dot colour — lives here and is unit-tested in dashboard.test.ts.

export type DayBucket = { key: string; label: string; count: number }

/** Local YYYY-MM-DD key for a date (so buckets align to the viewer's day). */
function dayKey(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/**
 * Group timestamped rows into the last `days` calendar days (local time),
 * oldest → newest, so a bar chart reads left-to-right. Rows outside the window
 * are ignored. `label` is a short weekday for the axis.
 */
export function bucketByDay(
  rows: { created_at: string }[],
  days: number,
  now: Date = new Date(),
): DayBucket[] {
  const buckets: DayBucket[] = []
  const index = new Map<string, number>()
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now)
    d.setHours(0, 0, 0, 0)
    d.setDate(d.getDate() - i)
    const key = dayKey(d)
    index.set(key, buckets.length)
    buckets.push({
      key,
      label: d.toLocaleDateString(undefined, { weekday: 'short' }),
      count: 0,
    })
  }
  for (const r of rows) {
    const idx = index.get(dayKey(new Date(r.created_at)))
    if (idx !== undefined) buckets[idx].count++
  }
  return buckets
}

/** Whole-percent completion, guarding divide-by-zero (0 when nothing exists). */
export function completionPct(done: number, total: number): number {
  if (total <= 0) return 0
  return Math.round((done / total) * 100)
}

/** Compact relative time ("just now", "5m ago", "3h ago", "2d ago", …). */
export function timeAgo(iso: string, now: Date = new Date()): string {
  const secs = Math.max(0, Math.floor((now.getTime() - new Date(iso).getTime()) / 1000))
  if (secs < 60) return 'just now'
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  if (days < 7) return `${days}d ago`
  const weeks = Math.floor(days / 7)
  if (weeks < 5) return `${weeks}w ago`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months}mo ago`
  return `${Math.floor(days / 365)}y ago`
}

export type ActivityFamily = { key: string; label: string; dot: string }

/**
 * Map an `activity_log.type` to a human family label + a Tailwind dot colour,
 * so the dashboard feed is scannable at a glance. Mirrors the family split used
 * on ActivityPage (kept here as data so it can be unit-tested).
 */
export function activityFamily(type: string): ActivityFamily {
  if (type.startsWith('guardrail')) return { key: 'guardrail', label: 'Guardrail', dot: 'bg-red-500' }
  if (type.startsWith('feedback')) return { key: 'feedback', label: 'Feedback', dot: 'bg-emerald-500' }
  if (type.endsWith('.error')) return { key: 'error', label: 'Error', dot: 'bg-red-500' }
  if (type.startsWith('chat')) return { key: 'chat', label: 'Chat', dot: 'bg-primary' }
  if (type.startsWith('schedule')) return { key: 'schedule', label: 'Schedule', dot: 'bg-violet-500' }
  if (type.startsWith('webhook')) return { key: 'webhook', label: 'Webhook', dot: 'bg-amber-500' }
  if (type.startsWith('tool')) return { key: 'tool', label: 'Tool', dot: 'bg-indigo-500' }
  if (type.startsWith('artifact')) return { key: 'artifact', label: 'Artifact', dot: 'bg-emerald-500' }
  if (type.startsWith('file')) return { key: 'file', label: 'File', dot: 'bg-sky-500' }
  if (type.startsWith('todo')) return { key: 'todo', label: 'To-do', dot: 'bg-teal-500' }
  if (type.startsWith('email')) return { key: 'email', label: 'Email', dot: 'bg-blue-500' }
  if (type.startsWith('secret')) return { key: 'secret', label: 'Secret', dot: 'bg-rose-500' }
  return { key: 'other', label: 'Event', dot: 'bg-slate-400' }
}
