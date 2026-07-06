// Supabase Edge Function: `message-inbound` (PUBLIC — verify_jwt=false, gated in
// code by a per-user bearer token). The generic "push a message into my inbox"
// endpoint: Slack / WhatsApp / Zapier / a script / anything POSTs a normalized
// message here and it lands in the unified `messages` table as the token's owner,
// where it shows in the Inbox, can be filed into collections, and emits a
// `message.received` event for listeners to automate on.
//
// Auth: Authorization: Bearer <token> — a personal mcp_tokens token (Settings →
// Connect Claude / the API page) or a Supabase session JWT. Same resolver as
// run-tool, so one credential works across all the token-gated functions.
//
// Body: { source?, from?, subject?, body, url?, external_id?, received_at?,
//         visibility?, metadata? }. Only `body` is required.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4'
import { parseBearer, resolveApiUser } from '../_shared/apiauth.ts'

const MAX_BODY = 50_000
const SOURCES = ['email', 'slack', 'whatsapp', 'sms', 'webhook', 'manual', 'other']

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

const DOCS = `message-inbound — push a message into the unified inbox.

Auth:  Authorization: Bearer <token>   (a Connect-Claude token or a session JWT)
POST   /functions/v1/message-inbound
Body (JSON):
  {
    "body": "the message text",         (required)
    "source": "slack",                  (email|slack|whatsapp|sms|webhook|manual|other, default manual)
    "from": "Jane <jane@x.com>",        (sender name/email/handle/phone)
    "subject": "optional title",
    "url": "https://link-to-original",
    "external_id": "provider-msg-id",   (dedupe key within a source)
    "received_at": "2026-07-06T12:00:00Z",
    "visibility": "private|workspace",  (default private)
    "metadata": { ... }                 (any extra JSON)
  }
-> { "ok": true, "id": "<message id>" }
`

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method === 'GET') return new Response(DOCS, { headers: { ...CORS, 'Content-Type': 'text/plain; charset=utf-8' } })
  if (req.method !== 'POST') return json({ error: 'Use POST' }, 405)

  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!supabaseUrl || !serviceKey) return json({ error: 'Server not configured' }, 500)
  const db = createClient(supabaseUrl, serviceKey)

  const userId = await resolveApiUser(db, parseBearer(req.headers.get('authorization')))
  if (!userId) return json({ error: 'unauthorized' }, 401)

  let payload: Record<string, unknown>
  try {
    payload = (await req.json()) as Record<string, unknown>
  } catch {
    return json({ error: 'invalid JSON' }, 400)
  }

  const body = str(payload.body).trim()
  if (!body) return json({ error: 'A "body" field is required.' }, 400)

  const source = SOURCES.includes(str(payload.source)) ? str(payload.source) : 'manual'
  const visibility = str(payload.visibility) === 'workspace' ? 'workspace' : 'private'
  const receivedAt = str(payload.received_at)
  const from = str(payload.from)

  const { data, error } = await db
    .from('inbox_messages')
    .insert({
      owner_id: userId,
      source,
      external_id: str(payload.external_id) || null,
      from_name: from,
      from_address: from,
      subject: str(payload.subject),
      body_text: body.slice(0, MAX_BODY),
      url: str(payload.url) || null,
      visibility,
      received_at: receivedAt && !Number.isNaN(Date.parse(receivedAt)) ? receivedAt : undefined,
      raw: payload.metadata && typeof payload.metadata === 'object' ? payload.metadata : {},
    })
    .select('id')
    .single()

  if (error) {
    // A duplicate (source, external_id) is a benign re-delivery, not an error.
    if (error.code === '23505') return json({ ok: true, duplicate: true })
    return json({ error: error.message }, 500)
  }
  return json({ ok: true, id: data.id })
})
