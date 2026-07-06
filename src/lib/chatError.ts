// Turn a raw chat failure into a short, human-readable line for the error
// banner. The raw value can be:
//   - an already-parsed message from the edge function's SSE `error` event
//     (e.g. "Rate limited (429): You have exceeded your credits"),
//   - the streamChat wrapper "Chat request failed (500). {json}" when the
//     function itself returns non-2xx (its body is usually {"error":"…"}),
//   - a network-level failure ("Failed to fetch", "Load failed", …).
// We keep this pure + unit-tested so a nested JSON blob never lands in the UI
// as a "crazy error" again.

// Find the first balanced-ish JSON object in a string and pull the human message
// out of it. Handles our own {"error":"…"} bodies and OpenRouter/provider
// {"error":{"message":"…"}} blobs that slip through un-parsed.
function messageFromEmbeddedJson(text: string): string | null {
  const start = text.indexOf('{')
  if (start === -1) return null
  // Try progressively shorter suffixes isn't worth it; parse from the first
  // brace to the last brace, which covers the common "prefix. {json}" shape.
  const end = text.lastIndexOf('}')
  if (end <= start) return null
  try {
    return pickMessage(JSON.parse(text.slice(start, end + 1)))
  } catch {
    return null
  }
}

function pickMessage(obj: unknown, depth = 0): string | null {
  if (depth > 5 || !obj || typeof obj !== 'object') {
    return typeof obj === 'string' && obj.trim() ? obj.trim() : null
  }
  const o = obj as Record<string, unknown>
  if ('error' in o) {
    const inner = pickMessage(o.error, depth + 1)
    if (inner) return inner
  }
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

export function friendlyChatError(raw: unknown, fallback = 'Something went wrong. Please try again.'): string {
  const text = (raw instanceof Error ? raw.message : String(raw ?? '')).trim()
  if (!text) return fallback
  // Network-level failures never reached the server — say so plainly.
  if (/failed to fetch|networkerror|load failed|err_network|network request failed/i.test(text))
    return 'Couldn’t reach the server — check your connection and try again.'
  const embedded = messageFromEmbeddedJson(text)
  if (embedded) {
    // Keep the "Chat request failed (500)." status prefix if present so the
    // reader still sees it, but replace the raw blob with the parsed message.
    const prefix = text.match(/^Chat request failed \(\d+\)\./)?.[0]
    return prefix ? `${prefix} ${embedded}` : embedded
  }
  return text
}
