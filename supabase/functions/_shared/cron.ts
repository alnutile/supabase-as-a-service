// Pure cron helpers shared by the scheduler edge function (and mirrored by the
// browser helper in src/lib/cron.ts). Kept side-effect-free and dependency-thin
// so the scheduler's next-run math is unit-testable without a DB or a clock.
//
// Standard 5-field cron: `minute hour day-of-month month day-of-week`. We lean on
// croner, so the croner extensions work too — notably `L` (last day of month),
// which is how "run on the last day of the month" is expressed. Evaluation is in
// an IANA `timezone` so "9am on the 15th" means 9am *there*, not UTC.
// URL import (not `npm:`) on purpose: the deno test job runs with the repo's
// package.json present but no node_modules, which puts Deno in byonm mode where
// `npm:` specifiers demand an installed node_modules. A remote URL import bypasses
// that and resolves from Deno's global cache in CI. (The browser mirror
// src/lib/cron.ts imports the same croner from node_modules via Vite.)
import { Cron } from 'https://esm.sh/croner@8.1.2'

// Number of cron fields we accept. We deliberately require the classic 5 (no
// seconds field) so the UI's "* * * * *" documentation matches reality — the
// pg_cron tick is per-minute, so a seconds field would be a lie.
const FIELD_COUNT = 5

/** True if `expr` is a well-formed 5-field cron croner can schedule. */
export function isValidCron(expr: string): boolean {
  const trimmed = (expr ?? '').trim()
  if (!trimmed) return false
  if (trimmed.split(/\s+/).length !== FIELD_COUNT) return false
  try {
    // Constructing without a handler just parses/validates the pattern.
    const c = new Cron(trimmed)
    // A pattern that can never fire (e.g. Feb 30) yields no next run — treat as invalid.
    return c.nextRun() !== null
  } catch {
    return false
  }
}

/**
 * The first fire time strictly after `after`, evaluated in `timezone`.
 * Returns null when the expression is invalid or has no future occurrence.
 */
export function nextCronRun(expr: string, timezone: string, after: Date): Date | null {
  const trimmed = (expr ?? '').trim()
  if (!trimmed || trimmed.split(/\s+/).length !== FIELD_COUNT) return null
  try {
    const c = new Cron(trimmed, { timezone: timezone || 'UTC' })
    return c.nextRun(after)
  } catch {
    return null
  }
}
