// Turn a raw upstream (OpenRouter / provider) error into a short, human-readable
// line. The body OpenRouter returns on a failure is often a big nested JSON blob
// — e.g. {"error":{"message":"…","code":429,"metadata":{"raw":"{…}"}}} — which,
// dumped straight into the chat error banner, reads as a "crazy error". Pulling
// out the actual message (and labelling the HTTP status) makes model failures
// legible everywhere the loops surface them. Kept pure so it's unit-tested and
// shared by every OpenRouter call site (chat, webhook, scheduler, guardrails).

// Recursively pull the most specific human message out of a parsed OpenRouter/
// provider error object. Handles the common shapes:
//   { error: { message, code, metadata: { raw: "<json string>" } } }
//   { message: "…" }              (provider passthrough)
//   { error: "…" }                (our own edge functions)
function pickMessage(obj: unknown, depth = 0): string | null {
  if (depth > 5 || !obj || typeof obj !== 'object') {
    return typeof obj === 'string' && obj.trim() ? obj.trim() : null
  }
  const o = obj as Record<string, unknown>
  // Nested { error: … } — recurse into it first (most specific wins).
  if ('error' in o) {
    const inner = pickMessage(o.error, depth + 1)
    if (inner) return inner
  }
  // Some providers tuck the real error under metadata.raw as a JSON string —
  // prefer it over the generic wrapper `message` at this level.
  const meta = o.metadata
  if (meta && typeof meta === 'object') {
    const raw = (meta as Record<string, unknown>).raw
    if (typeof raw === 'string' && raw.trim()) {
      try {
        const nested = pickMessage(JSON.parse(raw), depth + 1)
        if (nested) return nested
      } catch {
        return raw.trim()
      }
    }
  }
  if (typeof o.message === 'string' && o.message.trim()) return o.message.trim()
  return null
}

// A friendly label for the well-known HTTP statuses so the reader sees *what
// kind* of failure it was without decoding numbers.
function statusLabel(status: number): string {
  if (status === 429) return 'Rate limited'
  if (status === 401 || status === 403) return 'Auth failed'
  if (status === 402) return 'Payment/credits required'
  if (status === 400) return 'Bad request'
  if (status === 404) return 'Model not found'
  if (status >= 500) return 'Upstream model error'
  return 'Model request failed'
}

export function describeModelError(status: number, body: string): string {
  const trimmed = (body ?? '').trim()
  let message: string | null = null
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      message = pickMessage(JSON.parse(trimmed))
    } catch {
      message = null
    }
  }
  if (!message) message = trimmed.slice(0, 300) || 'no response body'
  return `${statusLabel(status)} (${status}): ${message}`.slice(0, 500)
}
