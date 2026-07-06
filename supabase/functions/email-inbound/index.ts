// Supabase Edge Function: `email-inbound` (PUBLIC — verify_jwt=false).
// Email providers (Postmark inbound / Resend inbound) POST each incoming message
// to /functions/v1/email-inbound/<inbound_token>. We resolve the integration by
// token, normalize the provider's payload, and store it in the unified `messages`
// inbox (source='email', shared workspace-wide). The `check_email` builtin reads
// email rows there — receiving is push, not polling.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4'

const MAX_BODY = 50_000

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })
}

// Same token-extraction shape as the webhook function.
function extractToken(url: URL): string | null {
  const q = url.searchParams.get('token')
  if (q) return q.trim()
  const parts = url.pathname.split('/').filter(Boolean)
  const i = parts.indexOf('email-inbound')
  if (i !== -1 && parts[i + 1]) return parts[i + 1]
  const last = parts[parts.length - 1]
  return last && last !== 'email-inbound' ? last : null
}

function stripHtml(html: unknown): string {
  if (typeof html !== 'string') return ''
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
}

function firstNonEmpty(...vals: unknown[]): string {
  for (const v of vals) {
    if (typeof v === 'string' && v.trim() !== '') return v
  }
  return ''
}

interface Normalized {
  from: string
  to: string
  subject: string
  text: string
  raw: Record<string, unknown>
}

// Tolerant normalizer covering Postmark inbound and Resend inbound payloads.
// deno-lint-ignore no-explicit-any
function normalize(p: any): Normalized {
  // Postmark inbound: From / FromFull.Email / TextBody / HtmlBody / Attachments[].
  if (p && (p.FromFull || p.TextBody !== undefined || p.HtmlBody !== undefined)) {
    const attachments = Array.isArray(p.Attachments)
      ? p.Attachments.map((a: Record<string, unknown>) => ({ name: a.Name, length: a.ContentLength }))
      : []
    return {
      from: firstNonEmpty(p.FromFull?.Email, p.From),
      to: firstNonEmpty(p.OriginalRecipient, p.ToFull?.[0]?.Email, p.To),
      subject: firstNonEmpty(p.Subject),
      text: firstNonEmpty(p.TextBody, stripHtml(p.HtmlBody)),
      raw: { provider: 'postmark', message_id: p.MessageID, attachments },
    }
  }
  // Resend inbound: an event envelope ({ type, data }) or a flat object.
  const d = p?.data ?? p ?? {}
  const toField = Array.isArray(d.to) ? d.to.join(', ') : d.to
  const fromField = d.from && typeof d.from === 'object' ? (d.from.address ?? d.from.email) : d.from
  const attachments = Array.isArray(d.attachments)
    ? d.attachments.map((a: Record<string, unknown>) => ({ name: a.filename ?? a.name }))
    : []
  return {
    from: firstNonEmpty(fromField),
    to: firstNonEmpty(toField),
    subject: firstNonEmpty(d.subject),
    text: firstNonEmpty(d.text, stripHtml(d.html)),
    raw: { provider: 'resend', message_id: d.email_id ?? d.id, attachments },
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return json({ error: 'Use POST' }, 405)

  const url = new URL(req.url)
  const token = extractToken(url)
  if (!token) return json({ error: 'unauthorized' }, 401)

  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!supabaseUrl || !serviceKey) return json({ error: 'Server not configured' }, 500)
  const db = createClient(supabaseUrl, serviceKey)

  const { data: integ } = await db
    .from('integrations')
    .select('id')
    .eq('kind', 'email')
    .eq('inbound_token', token)
    .maybeSingle()
  if (!integ) return json({ error: 'unauthorized' }, 401)

  let payload: unknown
  try {
    payload = await req.json()
  } catch {
    return json({ error: 'invalid JSON' }, 400)
  }

  const msg = normalize(payload)
  // Shared email lands in the unified inbox owned by the first admin, visible to
  // the whole workspace (matching the old admin-readable inbox model).
  const { data: owner } = await db
    .from('profiles')
    .select('id')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()
  const messageId = typeof msg.raw.message_id === 'string' ? msg.raw.message_id : null
  await db.from('inbox_messages').insert({
    owner_id: owner?.id ?? null,
    source: 'email',
    external_id: messageId,
    from_address: msg.from || '(unknown)',
    to_address: msg.to || null,
    subject: msg.subject,
    body_text: msg.text.slice(0, MAX_BODY),
    visibility: 'workspace',
    raw: msg.raw,
  })
  await db.from('activity_log').insert({
    type: 'email.received',
    summary: `Email from ${msg.from || 'unknown'}: ${msg.subject || '(no subject)'}`,
    detail: { from: msg.from, subject: msg.subject },
    actor_id: null,
  })

  return json({ ok: true })
})
