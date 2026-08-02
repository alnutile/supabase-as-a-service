import { chatFunctionUrl, supabase } from './supabase'
import type { MessageRole } from './database.types'

export interface ChatAttachment {
  path: string
  name: string
  mime?: string
}

export interface ChatMessage {
  role: Exclude<MessageRole, 'system'>
  content: string
  attachments?: ChatAttachment[]
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
  options?: {
    system?: string
    replaceSystem?: boolean
    toolIds?: string[]
    collectionIds?: string[]
    cardBoardId?: string
    // When the chat is driving a specific agent (?agent=id), attribute the run to
    // it so it shows up on the agent's runs/observability page.
    agentId?: string
    // Server-side persistence (the main chat composer): the chat function writes
    // the assistant reply itself, in a background task that survives the browser
    // navigating away or reloading. `runId` (a fresh uuid per send) lets Stop
    // truly cancel that background run. When persist is set, the function hands
    // back the saved artifact/message rows over SSE via these callbacks so a
    // still-connected client updates instantly instead of inserting them itself.
    conversationId?: string
    persist?: boolean
    runId?: string
    onArtifact?: (artifact: unknown) => void
    onMessage?: (message: unknown) => void
    signal?: AbortSignal
  },
): Promise<string> {
  const {
    data: { session },
  } = await supabase.auth.getSession()
  if (!session) throw new Error('Not authenticated')

  const res = await fetch(chatFunctionUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: import.meta.env.VITE_SUPABASE_ANON_KEY as string,
      Authorization: `Bearer ${session.access_token}`,
    },
    body: JSON.stringify({
      messages,
      system: options?.system,
      replaceSystem: options?.replaceSystem,
      toolIds: options?.toolIds,
      collectionIds: options?.collectionIds,
      cardBoardId: options?.cardBoardId,
      agentId: options?.agentId,
      conversationId: options?.conversationId,
      persist: options?.persist,
      runId: options?.runId,
    }),
    signal: options?.signal,
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
        // Server-persisted rows (persist mode): open the artifact panel / add the
        // saved assistant message to the thread without a client-side insert.
        if (json.artifact) {
          options?.onArtifact?.(json.artifact)
          continue
        }
        if (json.message) {
          options?.onMessage?.(json.message)
          continue
        }
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
