// Persist the per-collection floating chat history so closing the panel (or
// navigating away from the dashboard, which unmounts the component) doesn't
// throw away the conversation. Same localStorage trust model as the panel-resize
// widths and nav state — it's a per-browser convenience, not cross-device sync.

export type CollectionChatMessage = { role: 'user' | 'assistant'; content: string }

// Cap what we keep so a very long conversation can't blow the localStorage quota.
const MAX_MESSAGES = 200

export function collectionChatKey(collectionId: string): string {
  return `collection-chat:${collectionId}`
}

// Parse a stored payload back into a clean message list. Never throws — any
// malformed/legacy value yields an empty history so the UI still loads.
export function parseCollectionChat(raw: string | null): CollectionChatMessage[] {
  if (!raw) return []
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(data)) return []
  const out: CollectionChatMessage[] = []
  for (const item of data) {
    if (
      item &&
      typeof item === 'object' &&
      (item as { role?: unknown }).role &&
      typeof (item as { content?: unknown }).content === 'string'
    ) {
      const role = (item as { role: unknown }).role
      if (role === 'user' || role === 'assistant') {
        out.push({ role, content: (item as { content: string }).content })
      }
    }
  }
  return out
}

// Serialize a message list for storage, trimming to the most recent MAX_MESSAGES.
export function serializeCollectionChat(messages: CollectionChatMessage[]): string {
  const trimmed = messages.length > MAX_MESSAGES ? messages.slice(-MAX_MESSAGES) : messages
  return JSON.stringify(trimmed)
}

export function loadCollectionChat(collectionId: string): CollectionChatMessage[] {
  if (typeof localStorage === 'undefined') return []
  return parseCollectionChat(localStorage.getItem(collectionChatKey(collectionId)))
}

export function saveCollectionChat(collectionId: string, messages: CollectionChatMessage[]): void {
  if (typeof localStorage === 'undefined') return
  try {
    if (messages.length === 0) {
      localStorage.removeItem(collectionChatKey(collectionId))
    } else {
      localStorage.setItem(collectionChatKey(collectionId), serializeCollectionChat(messages))
    }
  } catch {
    // Quota exceeded / storage disabled — history persistence is best-effort.
  }
}
