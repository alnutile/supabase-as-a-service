import { describe, expect, it } from 'vitest'
import { friendlyChatError } from './chatError'

describe('friendlyChatError', () => {
  it('passes an already-parsed message through unchanged', () => {
    expect(friendlyChatError('Rate limited (429): You have exceeded your credits')).toBe(
      'Rate limited (429): You have exceeded your credits',
    )
  })

  it('unwraps the edge function body but keeps the status prefix', () => {
    expect(
      friendlyChatError('Chat request failed (500). {"error":"OPENROUTER_API_KEY is not configured"}'),
    ).toBe('Chat request failed (500). OPENROUTER_API_KEY is not configured')
  })

  it('extracts a nested OpenRouter { error: { message } } blob', () => {
    expect(
      friendlyChatError('{"error":{"message":"This model is not available","code":404}}'),
    ).toBe('This model is not available')
  })

  it('digs into metadata.raw for the real provider message', () => {
    const raw = JSON.stringify({
      error: { message: 'wrapper', metadata: { raw: JSON.stringify({ error: { message: 'context length exceeded' } }) } },
    })
    expect(friendlyChatError(raw)).toBe('context length exceeded')
  })

  it('gives a plain message for network failures', () => {
    expect(friendlyChatError(new Error('Failed to fetch'))).toMatch(/couldn’t reach the server/i)
    expect(friendlyChatError('TypeError: Load failed')).toMatch(/couldn’t reach the server/i)
  })

  it('accepts Error instances and reads their message', () => {
    expect(friendlyChatError(new Error('model exploded'))).toBe('model exploded')
  })

  it('uses the fallback for empty/nullish input', () => {
    expect(friendlyChatError('', 'Failed to send')).toBe('Failed to send')
    expect(friendlyChatError(null, 'Failed to send')).toBe('Failed to send')
  })
})
