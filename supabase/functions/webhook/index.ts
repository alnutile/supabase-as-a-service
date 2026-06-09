// Supabase Edge Function: `webhook` (PUBLIC — deployed with verify_jwt=false).
// External systems POST data to /functions/v1/webhook/<token>. We look up the
// webhook by its opaque token, run its attached prompt against the incoming
// payload via Claude, and log the event + result. Access is gated entirely by
// the unguessable token in the URL.
import Anthropic from 'npm:@anthropic-ai/sdk@0.69.0'
import { createClient } from 'npm:@supabase/supabase-js@2.45.4'

const MODEL = Deno.env.get('ANTHROPIC_MODEL') ?? 'claude-opus-4-8'
const EFFORT = (Deno.env.get('ANTHROPIC_EFFORT') ?? 'medium') as 'low' | 'medium' | 'high'

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

// Token can come from the trailing path segment (/webhook/<token>) or ?token=.
function extractToken(url: URL): string | null {
  const q = url.searchParams.get('token')
  if (q) return q.trim()
  const parts = url.pathname.split('/').filter(Boolean)
  const i = parts.indexOf('webhook')
  if (i !== -1 && parts[i + 1]) return parts[i + 1]
  const last = parts[parts.length - 1]
  return last && last !== 'webhook' ? last : null
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return json({ error: 'Use POST' }, 405)

  const url = new URL(req.url)
  const token = extractToken(url)
  if (!token) return json({ error: 'Missing webhook token' }, 400)

  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  const apiKey = Deno.env.get('ANTHROPIC_API_KEY')
  if (!supabaseUrl || !serviceKey || !apiKey) {
    return json({ error: 'Server not configured' }, 500)
  }
  const db = createClient(supabaseUrl, serviceKey)

  // Resolve the webhook.
  const { data: webhook } = await db
    .from('webhooks')
    .select('id, prompt, is_active')
    .eq('token', token)
    .maybeSingle()
  if (!webhook || !webhook.is_active) {
    return json({ error: 'Unknown or inactive webhook' }, 404)
  }

  // Read the payload (JSON if possible, otherwise raw text).
  const raw = await req.text()
  let payload: unknown
  let payloadText: string
  try {
    payload = raw ? JSON.parse(raw) : {}
    payloadText = JSON.stringify(payload, null, 2)
  } catch {
    payload = { raw }
    payloadText = raw
  }

  // Log the inbound event immediately so nothing is lost if the model call fails.
  const { data: event } = await db
    .from('webhook_events')
    .insert({ webhook_id: webhook.id, status: 'received', payload })
    .select('id')
    .single()
  const eventId = event?.id

  try {
    const anthropic = new Anthropic({ apiKey })
    const msg = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 4096,
      thinking: { type: 'adaptive' },
      output_config: { effort: EFFORT },
      system: webhook.prompt || 'Process the incoming webhook payload and summarize what it contains.',
      messages: [{ role: 'user', content: payloadText || '(empty payload)' }],
    })
    const result = msg.content
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim()

    if (eventId) {
      await db.from('webhook_events').update({ status: 'ok', result }).eq('id', eventId)
    }
    return json({ ok: true, event_id: eventId, result })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'processing failed'
    if (eventId) {
      await db.from('webhook_events').update({ status: 'error', error: message }).eq('id', eventId)
    }
    return json({ ok: false, event_id: eventId, error: message }, 502)
  }
})
