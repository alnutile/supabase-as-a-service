// Supabase Edge Function: `chat`
// Streams a Claude completion to the browser as SSE. The Anthropic API key
// stays server-side (set via `supabase secrets set ANTHROPIC_API_KEY=...`).
// Deployed with verify_jwt=true, so only authenticated users can call it.
//
// The system prompt is assembled from the always-on prompts in the `skills`
// table (auto_apply = true) — the built-in "How this workspace works" prompt
// plus any workspace-context prompts an admin has added. An invoked skill can
// either append to that context or replace it.
import Anthropic from 'npm:@anthropic-ai/sdk@0.69.0'
import { createClient } from 'npm:@supabase/supabase-js@2.45.4'

const MODEL = Deno.env.get('ANTHROPIC_MODEL') ?? 'claude-opus-4-8'
const EFFORT = (Deno.env.get('ANTHROPIC_EFFORT') ?? 'medium') as 'low' | 'medium' | 'high'

// Fallback if no always-on prompts exist (e.g. fresh local DB without the seed).
const DEFAULT_SYSTEM = `You are the assistant inside a Supabase-powered intranet. Be warm, concise, and practical.

When the user asks you to create, save, or share an artifact (a doc, code file, HTML page, etc.), output it as ONE block in EXACTLY this format:

:::artifact {"title":"Short title","type":"markdown"}
...the full content...
:::

"type" is one of: markdown, code, html, text. Put only the content between the fences; don't wrap the block in code fences. The app saves it as a shareable artifact automatically.`

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

function sse(data: unknown): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`)
}

async function loadAlwaysOnSystem(): Promise<string> {
  try {
    const url = Deno.env.get('SUPABASE_URL')
    const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    if (!url || !key) return DEFAULT_SYSTEM
    const admin = createClient(url, key)
    const { data } = await admin
      .from('skills')
      .select('instructions, is_builtin, created_at')
      .eq('auto_apply', true)
      .order('is_builtin', { ascending: false })
      .order('created_at', { ascending: true })
    const parts = (data ?? [])
      .map((r: { instructions: string }) => (r.instructions ?? '').trim())
      .filter(Boolean)
    return parts.length ? parts.join('\n\n---\n\n') : DEFAULT_SYSTEM
  } catch {
    return DEFAULT_SYSTEM
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS })
  }
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: CORS })
  }

  const apiKey = Deno.env.get('ANTHROPIC_API_KEY')
  if (!apiKey) {
    return new Response(JSON.stringify({ error: 'ANTHROPIC_API_KEY is not configured' }), {
      status: 500,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    })
  }

  let messages: ChatMessage[]
  let skillSystem = ''
  let replaceSystem = false
  try {
    const body = await req.json()
    messages = body.messages
    if (!Array.isArray(messages) || messages.length === 0) {
      throw new Error('`messages` must be a non-empty array')
    }
    if (typeof body.system === 'string') skillSystem = body.system
    replaceSystem = body.replaceSystem === true
  } catch (err) {
    return new Response(JSON.stringify({ error: err instanceof Error ? err.message : 'Bad request' }), {
      status: 400,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    })
  }

  // Assemble the effective system prompt.
  let system: string
  if (replaceSystem && skillSystem.trim()) {
    system = skillSystem
  } else {
    const base = await loadAlwaysOnSystem()
    system = skillSystem.trim() ? `${base}\n\n---\n\n${skillSystem}` : base
  }

  const anthropic = new Anthropic({ apiKey })

  const stream = new ReadableStream({
    async start(controller) {
      try {
        const llm = anthropic.messages.stream({
          model: MODEL,
          max_tokens: 8192,
          thinking: { type: 'adaptive' },
          output_config: { effort: EFFORT },
          system,
          messages: messages.map((m) => ({ role: m.role, content: m.content })),
        })
        llm.on('text', (delta: string) => {
          controller.enqueue(sse({ delta }))
        })
        await llm.finalMessage()
        controller.enqueue(sse('[DONE]'))
      } catch (err) {
        controller.enqueue(sse({ type: 'error', error: err instanceof Error ? err.message : 'stream failed' }))
      } finally {
        controller.close()
      }
    },
  })

  return new Response(stream, {
    headers: {
      ...CORS,
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  })
})
