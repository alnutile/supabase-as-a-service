// Pure event-listener matching logic, extracted so it can be unit-tested away
// from the dispatcher's DB/model side effects (the same pattern the repo uses
// for validate.ts, linkmeta.ts, slack.ts, etc.).
//
// An event listener fires when BOTH hold:
//   1. the listener's `event_type` matches the event's `type`
//      - '*'            → any event
//      - 'file.*'       → any event whose type is 'file' or starts with 'file.'
//      - 'file.created' → exact match
//   2. every filter in the listener's `match` object holds:
//      - entity_type  → event.entity_type === match.entity_type
//      - collection_id→ event.data.collection_id === match.collection_id
//      - source       → event.data.source === match.source  (message.* events)
//      - account_id   → event.data.account_id === match.account_id (one inbox)

export interface EventRow {
  id?: string
  type: string
  entity_type?: string | null
  entity_id?: string | null
  actor_id?: string | null
  summary?: string | null
  data?: Record<string, unknown> | null
  visibility?: string | null
}

export interface ListenerRow {
  id?: string
  event_type: string
  match?: Record<string, unknown> | null
  action_type?: string
  action_config?: Record<string, unknown> | null
}

export function typeMatches(pattern: string, type: string): boolean {
  if (!pattern) return false
  if (pattern === '*') return true
  if (pattern.endsWith('.*')) {
    const base = pattern.slice(0, -2)
    return type === base || type.startsWith(base + '.')
  }
  return pattern === type
}

export function matchListener(event: EventRow, listener: ListenerRow): boolean {
  if (!typeMatches(listener.event_type, event.type)) return false
  const m = listener.match ?? {}
  const data = event.data ?? {}

  if (typeof m.entity_type === 'string' && m.entity_type) {
    if ((event.entity_type ?? '') !== m.entity_type) return false
  }
  if (typeof m.collection_id === 'string' && m.collection_id) {
    if ((data as Record<string, unknown>).collection_id !== m.collection_id) return false
  }
  if (typeof m.source === 'string' && m.source) {
    if ((data as Record<string, unknown>).source !== m.source) return false
  }
  if (typeof m.account_id === 'string' && m.account_id) {
    if ((data as Record<string, unknown>).account_id !== m.account_id) return false
  }
  return true
}

// Replace {{event}} tokens (deep, in any string) with the event's JSON so a
// run_tool action can feed event context to a tool input. Mirrors run-tool's
// {{prev}} substitution.
export function substituteEvent<T>(input: T, event: EventRow): T {
  const json = JSON.stringify(event)
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return v.replace(/\{\{\s*event\s*\}\}/g, json)
    if (Array.isArray(v)) return v.map(walk)
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {}
      for (const [k, val] of Object.entries(v)) out[k] = walk(val)
      return out
    }
    return v
  }
  return walk(input) as T
}

// A short human description of an event, used to seed an agent's user turn.
export function describeEvent(event: EventRow): string {
  const parts = [`Event: ${event.type}`]
  if (event.summary) parts.push(String(event.summary))
  if (event.entity_type) parts.push(`entity: ${event.entity_type}${event.entity_id ? ` (${event.entity_id})` : ''}`)
  const data = event.data ?? {}
  if (Object.keys(data).length) parts.push(`data: ${JSON.stringify(data)}`)
  return parts.join('\n')
}
