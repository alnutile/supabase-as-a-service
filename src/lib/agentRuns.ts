// Pure helpers for the agent runs / observability page. Kept out of the
// component so the formatting + status logic is unit-tested (src/lib/agentRuns.test.ts).

export interface RunLike {
  started_at: string
  ended_at: string | null
  status: string
}

// Wall-clock duration of a run in ms, or null while it's still running / unknown.
export function runDurationMs(run: RunLike): number | null {
  if (!run.ended_at) return null
  const start = Date.parse(run.started_at)
  const end = Date.parse(run.ended_at)
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return null
  return end - start
}

// "340ms" / "1.2s" / "2m 5s" — a compact human duration from milliseconds.
export function formatDuration(ms: number | null): string {
  if (ms == null || ms < 0) return '—'
  if (ms < 1000) return `${Math.round(ms)}ms`
  const secs = ms / 1000
  if (secs < 60) return `${secs.toFixed(secs < 10 ? 1 : 0)}s`
  const m = Math.floor(secs / 60)
  const s = Math.round(secs % 60)
  return `${m}m ${s}s`
}

// A semantic color token for a run/step status (component maps it to classes).
export type Tone = 'amber' | 'emerald' | 'rose' | 'slate'
export function statusTone(status: string): Tone {
  switch (status) {
    case 'running':
      return 'amber'
    case 'done':
      return 'emerald'
    case 'error':
      return 'rose'
    default:
      return 'slate'
  }
}

// Human label for a run's trigger surface.
export function surfaceLabel(surface: string): string {
  const map: Record<string, string> = {
    chat: 'Chat',
    schedule: 'Scheduled',
    webhook: 'Webhook',
    slack: 'Slack',
    listener: 'Listener',
    manual: 'Manual',
  }
  return map[surface] ?? surface
}

// Thousands-separated token count; '—' for null/zero-unknown.
export function formatTokens(n: number | null | undefined): string {
  if (n == null) return '—'
  return n.toLocaleString('en-US')
}

// Cost in dollars with sensible precision (sub-cent runs still read as > $0).
export function formatCost(n: number | null | undefined): string {
  if (!n) return '$0'
  if (n < 0.01) return `$${n.toFixed(4)}`
  return `$${n.toFixed(2)}`
}
