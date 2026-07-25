// Workspace timezone — the IANA zone the agentic loops treat as "local" when
// telling the model what the current date/time is. Without it every unattended
// run reasons in UTC, which is the wrong clock for a team that lives elsewhere.
//
// `resolveWorkspaceTimezone` reads the admin-set value (Settings → Timezone);
// everything else here is pure so it can be unit-tested (tests/timezone_test.ts).
// Mirrors the shape of models.ts `resolveModel`: single-row read, safe fallback.

const DEFAULT_TZ = 'UTC'

/** True if `tz` is an IANA zone the runtime can format in. */
export function isValidTimezone(tz: string): boolean {
  const trimmed = (tz ?? '').trim()
  if (!trimmed) return false
  try {
    // Throws RangeError on an unknown zone.
    new Intl.DateTimeFormat('en-US', { timeZone: trimmed })
    return true
  } catch {
    return false
  }
}

/**
 * A human-readable rendering of `date` in `tz`, e.g.
 * "Friday, July 24, 2026, 3:04 PM EDT". Falls back to UTC for an invalid zone.
 */
export function formatInZone(date: Date, tz: string): string {
  const zone = isValidTimezone(tz) ? tz.trim() : DEFAULT_TZ
  return new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(date)
}

/**
 * The system-prompt section every agent loop prepends so the model knows the
 * real local date/time instead of guessing (or assuming UTC). Returns a titled
 * block ready to concatenate into a system prompt.
 */
export function currentTimeSection(tz: string, now: Date): string {
  const zone = isValidTimezone(tz) ? tz.trim() : DEFAULT_TZ
  return [
    '# Current date & time',
    `The current date and time is ${formatInZone(now, zone)} (timezone: ${zone}).`,
    'Treat this as the workspace-local clock for all date, time, scheduling, and "today/now" reasoning unless the user explicitly specifies another timezone.',
  ].join('\n')
}

/**
 * The workspace's configured IANA timezone, or 'UTC' when unset/invalid or the
 * row can't be read. Never throws — a bad value must not break an agent run.
 */
// deno-lint-ignore no-explicit-any
export async function resolveWorkspaceTimezone(db: any): Promise<string> {
  try {
    if (!db) return DEFAULT_TZ
    const { data } = await db
      .from('workspace_settings')
      .select('value')
      .eq('key', 'timezone')
      .maybeSingle()
    const tz = (data?.value as string | undefined)?.trim()
    return tz && isValidTimezone(tz) ? tz : DEFAULT_TZ
  } catch {
    return DEFAULT_TZ
  }
}
