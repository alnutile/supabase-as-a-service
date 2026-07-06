import { describe, it, expect } from 'vitest'
import {
  collectionChatKey,
  parseCollectionChat,
  serializeCollectionChat,
  type CollectionChatMessage,
} from './collectionChat'

describe('collectionChatKey', () => {
  it('namespaces by collection id', () => {
    expect(collectionChatKey('abc')).toBe('collection-chat:abc')
    expect(collectionChatKey('abc')).not.toBe(collectionChatKey('def'))
  })
})

describe('parseCollectionChat', () => {
  it('returns [] for null / empty', () => {
    expect(parseCollectionChat(null)).toEqual([])
    expect(parseCollectionChat('')).toEqual([])
  })

  it('returns [] for invalid JSON', () => {
    expect(parseCollectionChat('{not json')).toEqual([])
  })

  it('returns [] for non-array JSON', () => {
    expect(parseCollectionChat('{"role":"user","content":"hi"}')).toEqual([])
    expect(parseCollectionChat('42')).toEqual([])
  })

  it('keeps well-formed user/assistant messages', () => {
    const msgs: CollectionChatMessage[] = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi there' },
    ]
    expect(parseCollectionChat(JSON.stringify(msgs))).toEqual(msgs)
  })

  it('drops entries with bad roles or non-string content', () => {
    const raw = JSON.stringify([
      { role: 'user', content: 'ok' },
      { role: 'system', content: 'nope' },
      { role: 'assistant', content: 123 },
      { role: 'assistant' },
      null,
      'string',
      { role: 'assistant', content: 'good' },
    ])
    expect(parseCollectionChat(raw)).toEqual([
      { role: 'user', content: 'ok' },
      { role: 'assistant', content: 'good' },
    ])
  })
})

describe('serializeCollectionChat', () => {
  it('round-trips through parse', () => {
    const msgs: CollectionChatMessage[] = [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
    ]
    expect(parseCollectionChat(serializeCollectionChat(msgs))).toEqual(msgs)
  })

  it('trims to the most recent 200 messages', () => {
    const msgs: CollectionChatMessage[] = Array.from({ length: 250 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: String(i),
    }))
    const parsed = parseCollectionChat(serializeCollectionChat(msgs))
    expect(parsed).toHaveLength(200)
    expect(parsed[0].content).toBe('50')
    expect(parsed[199].content).toBe('249')
  })
})
