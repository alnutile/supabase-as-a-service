// Browser-side timezone helpers for Settings → Timezone. Pure (no React, no
// Supabase) so the picker/preview logic is unit-tested (timezone.test.ts). The
// saved value flows to the server via `workspace_settings` and into every agent
// loop's system prompt (supabase/functions/_shared/timezone.ts).

export const DEFAULT_TIMEZONE = 'UTC'

/** The browser's IANA timezone (e.g. "America/New_York"), or "UTC" if unknown. */
export function detectBrowserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || DEFAULT_TIMEZONE
  } catch {
    return DEFAULT_TIMEZONE
  }
}

/** True if `tz` is an IANA zone the runtime can format in. */
export function isValidTimezone(tz: string): boolean {
  const trimmed = (tz ?? '').trim()
  if (!trimmed) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: trimmed })
    return true
  } catch {
    return false
  }
}

// A small, curated fallback list of common zones for the picker, used only when
// the runtime doesn't expose the full IANA set. `allTimezones()` prefers the
// complete list when available.
const COMMON_TIMEZONES = [
  'UTC',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Anchorage',
  'America/Phoenix',
  'America/Toronto',
  'America/Sao_Paulo',
  'Europe/London',
  'Europe/Paris',
  'Europe/Berlin',
  'Europe/Madrid',
  'Europe/Athens',
  'Europe/Moscow',
  'Africa/Johannesburg',
  'Asia/Dubai',
  'Asia/Kolkata',
  'Asia/Bangkok',
  'Asia/Singapore',
  'Asia/Hong_Kong',
  'Asia/Shanghai',
  'Asia/Tokyo',
  'Australia/Sydney',
  'Pacific/Auckland',
  'Pacific/Honolulu',
]

/**
 * Every selectable IANA zone. Prefers the runtime's full set
 * (`Intl.supportedValuesOf`) and falls back to a curated common list. Always
 * includes `UTC` and returns a de-duplicated, sorted array.
 */
export function allTimezones(): string[] {
  let zones: string[] = COMMON_TIMEZONES
  try {
    // deno-lint-ignore no-explicit-any
    const supported = (Intl as any).supportedValuesOf?.('timeZone') as string[] | undefined
    if (supported && supported.length) zones = supported
  } catch {
    // keep the curated fallback
  }
  return Array.from(new Set(['UTC', ...zones])).sort()
}

/**
 * "Fri, Jul 24, 3:04 PM EDT" — a compact current-time label for the given zone,
 * used for the live preview beside the picker. Falls back to UTC for a bad zone.
 */
export function formatCurrentTime(tz: string, now: Date = new Date()): string {
  const zone = isValidTimezone(tz) ? tz.trim() : DEFAULT_TIMEZONE
  return new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(now)
}

/**
 * The UTC offset label for a zone at `now`, e.g. "UTC-04:00" (or "UTC" for the
 * zero offset). Handy for showing how far a picked zone sits from the default.
 */
export function utcOffsetLabel(tz: string, now: Date = new Date()): string {
  const zone = isValidTimezone(tz) ? tz.trim() : DEFAULT_TIMEZONE
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      timeZoneName: 'longOffset',
    }).formatToParts(now)
    const name = parts.find((p) => p.type === 'timeZoneName')?.value ?? 'UTC'
    // Intl returns "GMT-04:00", or "GMT"/"GMT+00:00" at the zero offset —
    // normalize the prefix to "UTC" and collapse the zero offset to plain "UTC".
    const label = name.replace(/^GMT/, 'UTC')
    return label === 'UTC' || /^UTC[+-]00:00$/.test(label) ? 'UTC' : label
  } catch {
    return 'UTC'
  }
}
