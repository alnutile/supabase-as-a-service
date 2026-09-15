import { describe, expect, it, vi } from 'vitest'
import { ApiError, createClient } from './api.js'

function stub(responses) {
  const calls = []
  const fetchImpl = vi.fn(async (url, init) => {
    calls.push({ url, init, body: init?.body ? JSON.parse(init.body) : null })
    const next = responses.shift() ?? { status: 200, body: {} }
    if (next.throws) throw new Error(next.throws)
    return {
      ok: next.status < 400,
      status: next.status,
      text: async () => (typeof next.body === 'string' ? next.body : JSON.stringify(next.body)),
    }
  })
  return { fetchImpl, calls }
}

const client = (fetchImpl) => createClient({ baseUrl: 'https://abc.supabase.co', token: 'tok_1', fetchImpl })

describe('createClient', () => {
  it('calls the functions endpoint with a bearer token', async () => {
    const { fetchImpl, calls } = stub([{ status: 200, body: { tools: [{ name: 'save_link' }, { name: 'list_todos' }] } }])
    const out = await client(fetchImpl).verify()
    expect(calls[0].url).toBe('https://abc.supabase.co/functions/v1/run-tool/list')
    expect(calls[0].init.headers.Authorization).toBe('Bearer tok_1')
    expect(out).toEqual({ toolCount: 2, canSaveLinks: true })
  })

  it('reports a rejected token in words the user can act on', async () => {
    const { fetchImpl } = stub([{ status: 401, body: {} }])
    await expect(client(fetchImpl).verify()).rejects.toThrow(/Settings -> Connect Claude/)
  })

  it('prefers the error message the function sent', async () => {
    const { fetchImpl } = stub([{ status: 400, body: { error: 'title is required.' } }])
    await expect(client(fetchImpl).createArtifact({ title: '', content: 'x' })).rejects.toThrow('title is required.')
  })

  it('turns a network failure into an ApiError naming the project URL', async () => {
    const { fetchImpl } = stub([{ throws: 'Failed to fetch' }])
    const error = await client(fetchImpl).verify().catch((e) => e)
    expect(error).toBeInstanceOf(ApiError)
    expect(error.message).toContain('https://abc.supabase.co')
  })

  it('parses the collection list out of run-tool text', async () => {
    const result = '• Reading (11111111-2222-3333-4444-555555555555) [private]'
    const { fetchImpl, calls } = stub([{ status: 200, body: { tool: 'list_collections', result } }])
    expect(await client(fetchImpl).listCollections()).toEqual([
      { id: '11111111-2222-3333-4444-555555555555', name: 'Reading', visibility: 'private', description: '' },
    ])
    expect(calls[0].body).toEqual({ tool: 'list_collections', input: {} })
  })

  it('sends only the link fields that were filled in', async () => {
    const result = 'Saved link "Hello" (id 11111111-2222-3333-4444-555555555555).'
    const { fetchImpl, calls } = stub([{ status: 200, body: { result } }])
    const saved = await client(fetchImpl).saveLink({ url: 'https://example.com', title: 'Hello', notes: '', collection: 'Reading' })
    expect(calls[0].body.input).toEqual({ url: 'https://example.com', title: 'Hello', collection: 'Reading' })
    expect(saved.id).toBe('11111111-2222-3333-4444-555555555555')
  })

  it('raises when the tool reports a failure in prose despite the 200', async () => {
    const { fetchImpl } = stub([{ status: 200, body: { result: 'Could not save the link: duplicate key' } }])
    await expect(client(fetchImpl).saveLink({ url: 'https://example.com' })).rejects.toThrow(/duplicate key/)
  })

  it('posts an artifact as markdown and omits an empty collections array', async () => {
    const { fetchImpl, calls } = stub([{ status: 201, body: { id: 'a1' } }])
    await client(fetchImpl).createArtifact({ title: 'T', content: '# T' })
    expect(calls[0].url).toBe('https://abc.supabase.co/functions/v1/artifacts')
    expect(calls[0].init.method).toBe('POST')
    expect(calls[0].body).toEqual({ title: 'T', content: '# T', type: 'markdown', visibility: 'private' })
  })

  it('passes collections through when one was chosen', async () => {
    const { fetchImpl, calls } = stub([{ status: 201, body: { id: 'a1' } }])
    await client(fetchImpl).createArtifact({ title: 'T', content: '# T', collections: ['Reading'] })
    expect(calls[0].body.collections).toEqual(['Reading'])
  })
})
