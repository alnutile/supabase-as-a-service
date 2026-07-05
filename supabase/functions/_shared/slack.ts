// Slack helpers for the `slack-events` function. The pure parts (signature
// computation, mention stripping, Slack-text decoding, mrkdwn conversion,
// event skip rules, transcript formatting) live here so they're unit-testable
// (supabase/functions/tests/slack_test.ts); the fetch helpers wrap Slack's
// Web API with the bot token the caller reads from Vault.

const encoder = new TextEncoder()

/** Max age (seconds) for x-slack-request-timestamp — replay-attack window. */
export const SLACK_MAX_SKEW_SECONDS = 60 * 5

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** Compute Slack's `v0=<hmac-sha256-hex>` request signature. Exported for tests. */
export async function computeSlackSignature(
  signingSecret: string,
  timestamp: string,
  body: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(signingSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const mac = await crypto.subtle.sign('HMAC', key, encoder.encode(`v0:${timestamp}:${body}`))
  return `v0=${toHex(mac)}`
}

/** Constant-time string compare (both sides are short hex signatures). */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/**
 * Verify a Slack Events API request: timestamp fresh (anti-replay) and the
 * HMAC signature matches. `nowSeconds` is injectable for tests.
 */
export async function verifySlackSignature(args: {
  signingSecret: string
  body: string
  timestamp: string | null
  signature: string | null
  nowSeconds?: number
}): Promise<boolean> {
  const { signingSecret, body, timestamp, signature } = args
  if (!signingSecret || !timestamp || !signature) return false
  const ts = Number(timestamp)
  if (!Number.isFinite(ts)) return false
  const now = args.nowSeconds ?? Math.floor(Date.now() / 1000)
  if (Math.abs(now - ts) > SLACK_MAX_SKEW_SECONDS) return false
  const expected = await computeSlackSignature(signingSecret, timestamp, body)
  return timingSafeEqual(expected, signature)
}

/**
 * Remove the bot's own <@U…> mention from a message. When the bot user id is
 * known every occurrence goes; otherwise only a leading mention is stripped
 * (so other people's mentions survive as content).
 */
export function stripBotMention(text: string, botUserId?: string | null): string {
  let out = text ?? ''
  if (botUserId) out = out.replaceAll(`<@${botUserId}>`, ' ')
  else out = out.replace(/^\s*<@[A-Z0-9]+>\s*/, ' ')
  return out.replace(/\s+/g, ' ').trim()
}

/**
 * Decode Slack message markup into plain text the model can read:
 * entities, user/channel mentions, and <url|label> links.
 */
export function slackTextToPlain(text: string): string {
  return (text ?? '')
    .replace(/<@([A-Z0-9]+)\|([^>]+)>/g, '@$2')
    .replace(/<@([A-Z0-9]+)>/g, '@$1')
    .replace(/<#[A-Z0-9]+\|([^>]+)>/g, '#$1')
    .replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/g, '$2 ($1)')
    .replace(/<(https?:\/\/[^>]+)>/g, '$1')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&')
}

/**
 * Convert the model's markdown reply into Slack mrkdwn: **bold** → *bold*,
 * headings → bold lines, [label](url) → <url|label>, `-` bullets → `•`.
 * Fenced code blocks pass through untouched.
 */
export function toMrkdwn(markdown: string): string {
  const parts = (markdown ?? '').split(/(```[\s\S]*?```)/g)
  return parts
    .map((part) => {
      if (part.startsWith('```')) return part
      return part
        .replace(/^#{1,6}\s+(.+)$/gm, '*$1*')
        .replace(/\*\*(.+?)\*\*/g, '*$1*')
        .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<$2|$1>')
        .replace(/^(\s*)[-*]\s+/gm, '$1• ')
    })
    .join('')
    .trim()
}

export interface SlackEvent {
  type?: string
  subtype?: string
  user?: string
  bot_id?: string
  text?: string
  channel?: string
  ts?: string
  thread_ts?: string
}

/**
 * Skip rule for incoming events — returns a reason string, or null to process.
 * Bot messages (including our own replies) and edits/system subtypes never
 * reach the model, so the bot can't answer itself in a loop.
 */
export function shouldSkipEvent(event: SlackEvent): string | null {
  if (event.bot_id) return 'bot message'
  if (event.subtype) return `subtype ${event.subtype}`
  if (!event.user) return 'no user'
  if (!event.channel) return 'no channel'
  if (!(event.text ?? '').trim()) return 'empty text'
  return null
}

export interface TranscriptMessage {
  user?: string
  bot_id?: string
  text?: string
  ts?: string
}

/**
 * Render recent channel/thread messages as a compact transcript block. The
 * triggering message (`excludeTs`) is left out — it's presented separately as
 * the actual request. Pure; names resolve through the provided map.
 */
export function formatTranscript(
  messages: TranscriptMessage[],
  names: Map<string, string>,
  excludeTs?: string,
): string {
  const lines: string[] = []
  for (const m of messages) {
    if (!(m.text ?? '').trim()) continue
    if (excludeTs && m.ts === excludeTs) continue
    const who = m.bot_id ? 'assistant (you)' : names.get(m.user ?? '') ?? m.user ?? 'someone'
    lines.push(`${who}: ${slackTextToPlain(m.text ?? '')}`)
  }
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Slack Web API (bot-token) helpers — thin, throw-free wrappers.

// Form-encoded on purpose: every Web API method accepts it, while only the
// write methods accept JSON bodies (conversations.history / users.info don't).
// deno-lint-ignore no-explicit-any
async function slackApi(botToken: string, method: string, payload: Record<string, unknown>): Promise<any> {
  const form = new URLSearchParams()
  for (const [k, v] of Object.entries(payload)) {
    if (v !== undefined && v !== null) form.set(k, String(v))
  }
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${botToken}`,
      'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8',
    },
    body: form.toString(),
  })
  return await res.json().catch(() => ({ ok: false, error: 'bad json' }))
}

const SLACK_TEXT_LIMIT = 12000

/** Post a message (threaded when threadTs is set). Returns Slack's `ok`. */
export async function postSlackMessage(
  botToken: string,
  channel: string,
  text: string,
  threadTs?: string | null,
): Promise<{ ok: boolean; error?: string }> {
  const body = text.length > SLACK_TEXT_LIMIT ? `${text.slice(0, SLACK_TEXT_LIMIT)}\n…(truncated)` : text
  const out = await slackApi(botToken, 'chat.postMessage', {
    channel,
    text: body,
    ...(threadTs ? { thread_ts: threadTs } : {}),
    unfurl_links: false,
  })
  return { ok: Boolean(out?.ok), error: out?.error }
}

/**
 * Fetch recent context: the thread's replies when the mention is in a thread,
 * otherwise the channel's last few messages. Ascending order; empty on error.
 */
export async function fetchSlackTranscript(
  botToken: string,
  channel: string,
  threadTs: string | null,
  limit = 15,
): Promise<TranscriptMessage[]> {
  try {
    const out = threadTs
      ? await slackApi(botToken, 'conversations.replies', { channel, ts: threadTs, limit })
      : await slackApi(botToken, 'conversations.history', { channel, limit })
    if (!out?.ok || !Array.isArray(out.messages)) return []
    const msgs = out.messages as TranscriptMessage[]
    // history is newest-first; replies are oldest-first already.
    const ordered = threadTs ? msgs : [...msgs].reverse()
    return ordered.slice(-limit)
  } catch {
    return []
  }
}

/** Resolve display names for a set of Slack user ids (best-effort, capped). */
export async function fetchSlackUserNames(
  botToken: string,
  userIds: string[],
): Promise<Map<string, string>> {
  const names = new Map<string, string>()
  for (const id of [...new Set(userIds)].slice(0, 10)) {
    try {
      const out = await slackApi(botToken, 'users.info', { user: id })
      const name = out?.user?.profile?.display_name || out?.user?.real_name || out?.user?.name
      if (out?.ok && name) names.set(id, String(name))
    } catch {
      // fall back to the raw id in the transcript
    }
  }
  return names
}
