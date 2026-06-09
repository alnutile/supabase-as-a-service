import { chatFunctionUrl, supabase } from './supabase'
import type { MessageRole } from './database.types'

export interface ChatMessage {
  role: Exclude<MessageRole, 'system'>
  content: string
}

/**
 * Streams a completion from the `chat` edge function.
 * Calls `onToken` for each text delta and resolves with the full text.
 * The edge function holds the Anthropic key server-side; we only pass the
 * user's access token so `verify_jwt` can authorize the call.
 */
export async function streamChat(
  messages: ChatMessage[],
  onToken: (delta: string) => void,
  signal?: AbortSignal,
): Promise<string> {
  const {
    data: { session },
  } = await supabase.auth.getSession()
  if (!session) throw new Error('Not authenticated')

  const res = await fetch(chatFunctionUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session.access_token}`,
    },
    body: JSON.stringify({ messages }),
    signal,
  })

  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => '')
    throw new Error(`Chat request failed (${res.status}). ${detail}`)
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let full = ''
  let buffer = ''

  // The function emits Server-Sent Events: lines beginning with "data: ".
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    const parts = buffer.split('\n\n')
    buffer = parts.pop() ?? ''
    for (const part of parts) {
      const line = part.trim()
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (payload === '[DONE]') return full
      try {
        const json = JSON.parse(payload)
        if (json.type === 'error') throw new Error(json.error || 'stream error')
        const delta: string = json.delta ?? ''
        if (delta) {
          full += delta
          onToken(delta)
        }
      } catch (err) {
        if (err instanceof SyntaxError) continue // partial JSON, ignore
        throw err
      }
    }
  }
  return full
}
