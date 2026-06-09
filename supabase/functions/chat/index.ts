// Supabase Edge Function: `chat`
// Streams a Claude completion to the browser as SSE. The Anthropic API key
// stays server-side (set via `supabase secrets set ANTHROPIC_API_KEY=...`).
// Deployed with verify_jwt=true, so only authenticated users can call it.
import Anthropic from 'npm:@anthropic-ai/sdk@0.69.0'

const MODEL = Deno.env.get('ANTHROPIC_MODEL') ?? 'claude-opus-4-8'
const EFFORT = (Deno.env.get('ANTHROPIC_EFFORT') ?? 'medium') as
  | 'low'
  | 'medium'
  | 'high'

const SYSTEM_PROMPT = `You are the assistant inside a friendly company intranet built on Supabase.
You help people think through ideas and build things: documents, plans, code snippets, small web pages, and structured notes.

Guidelines:
- Be warm, concise, and practical. Get to the point.
- When you produce something the user will want to keep or share — a document, a code file, an HTML page, a structured spec — format it cleanly in Markdown so it can be saved as an "artifact" and shared.
- Use fenced code blocks with a language tag for any code or HTML.
- Ask a brief clarifying question only when the request is genuinely ambiguous; otherwise make a reasonable choice and note it.`

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

function sse(data: unknown): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`)
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
    return new Response(
      JSON.stringify({ error: 'ANTHROPIC_API_KEY is not configured' }),
      { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } },
    )
  }

  let messages: ChatMessage[]
  try {
    const body = await req.json()
    messages = body.messages
    if (!Array.isArray(messages) || messages.length === 0) {
      throw new Error('`messages` must be a non-empty array')
    }
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : 'Bad request' }),
      { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } },
    )
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
          system: SYSTEM_PROMPT,
          messages: messages.map((m) => ({ role: m.role, content: m.content })),
        })

        llm.on('text', (delta: string) => {
          controller.enqueue(sse({ delta }))
        })

        await llm.finalMessage()
        controller.enqueue(sse('[DONE]'))
      } catch (err) {
        controller.enqueue(
          sse({ type: 'error', error: err instanceof Error ? err.message : 'stream failed' }),
        )
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
