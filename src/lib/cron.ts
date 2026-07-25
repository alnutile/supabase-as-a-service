// Browser-side cron helpers for the schedule editor — the mirror of
// supabase/functions/_shared/cron.ts. croner does validation + next-run previews
// (same engine the scheduler uses, so the preview matches what will actually
// fire), cronstrue turns an expression into plain English for the UI.
//
// Standard 5-field cron: `minute hour day-of-month month day-of-week`.
import { Cron } from 'croner'
import cronstrue from 'cronstrue'

const FIELD_COUNT = 5

/** The browser's IANA timezone (e.g. "America/New_York"), or "UTC" if unknown. */
export function localTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

/** True if `expr` is a well-formed 5-field cron croner can schedule. */
export function isValidCron(expr: string): boolean {
  const trimmed = (expr ?? '').trim()
  if (!trimmed || trimmed.split(/\s+/).length !== FIELD_COUNT) return false
  try {
    return new Cron(trimmed).nextRun() !== null
  } catch {
    return false
  }
}

/**
 * Plain-English description of a cron expression, or null if it can't be parsed.
 * cronstrue doesn't understand croner's `L` (last day of month), so we special-case
 * a common "last day" shape and otherwise fall back gracefully.
 */
export function describeCron(expr: string): string | null {
  const trimmed = (expr ?? '').trim()
  if (!isValidCron(trimmed)) return null
  // cronstrue throws on the `L` extension — describe the frequent "min hour L * *" form ourselves.
  const lastDay = trimmed.match(/^(\S+)\s+(\S+)\s+L\s+(\S+)\s+(\S+)$/)
  if (lastDay) {
    try {
      const timePart = cronstrue.toString(`${lastDay[1]} ${lastDay[2]} 1 ${lastDay[3]} ${lastDay[4]}`)
        .replace(/,?\s*on day 1 of the month/i, '')
      return `${timePart}, on the last day of the month`
    } catch {
      return 'On the last day of the month'
    }
  }
  try {
    return cronstrue.toString(trimmed, { verbose: false })
  } catch {
    return null
  }
}

/**
 * The next `count` fire times strictly after `after`, evaluated in `timezone`.
 * Returns [] for an invalid expression.
 */
export function nextCronRuns(expr: string, timezone: string, count = 3, after: Date = new Date()): Date[] {
  if (!isValidCron(expr)) return []
  try {
    const c = new Cron(expr.trim(), { timezone: timezone || 'UTC' })
    return (c.nextRuns(count, after) ?? []) as Date[]
  } catch {
    return []
  }
}

// Copy-to-fill examples shown in the cron syntax helper. Chosen to cover the
// cases the interval presets can't: specific day-of-month, weekday-at-a-time,
// and last-day-of-month.
export const CRON_EXAMPLES: { expr: string; label: string }[] = [
  { expr: '0 9 * * *', label: 'Every day at 9:00am' },
  { expr: '0 9 * * 1', label: 'Every Monday at 9:00am' },
  { expr: '0 9 * * 1-5', label: 'Weekdays at 9:00am' },
  { expr: '0 9 1 * *', label: '1st of the month at 9:00am' },
  { expr: '0 9 15 * *', label: '15th of the month at 9:00am' },
  { expr: '0 17 L * *', label: 'Last day of the month at 5:00pm' },
  { expr: '*/30 * * * *', label: 'Every 30 minutes' },
  { expr: '0 */6 * * *', label: 'Every 6 hours' },
]
