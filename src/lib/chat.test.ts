import { afterEach, describe, expect, it, vi } from 'vitest'
import { streamChat } from './chat'

// streamChat only needs a session token and the function URL from ./supabase —
// stub both so no real client (or env vars) is involved.
vi.mock('./supabase', () => ({
  chatFunctionUrl: 'https://example.test/functions/v1/chat',
  supabase: {
    auth: {
      getSession: () =>
        Promise.resolve({ data: { session: { access_token: 'test-token' } } }),
    },
  },
}))

// Build a Response whose body streams the given chunks — the exact SSE shape
// the chat edge function emits (`data: {"delta": …}` … `data: [DONE]`).
function sseResponse(chunks: string[], status = 200): Response {
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c))
      controller.close()
    },
  })
  return new Response(body, { status })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('streamChat', () => {
  it('accumulates deltas and reports each token', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sseResponse([
          'data: {"delta":"Hel"}\n\n',
          'data: {"delta":"lo"}\n\n',
          'data: [DONE]\n\n',
        ]),
      ),
    )
    const tokens: string[] = []
    const full = await streamChat([{ role: 'user', content: 'hi' }], (d) => tokens.push(d))
    expect(full).toBe('Hello')
    expect(tokens).toEqual(['Hel', 'lo'])
  })

  it('reassembles events split across network chunks', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sseResponse(['data: {"del', 'ta":"abc"}\n', '\ndata: [DONE]\n\n']),
      ),
    )
    const full = await streamChat([{ role: 'user', content: 'hi' }], () => {})
    expect(full).toBe('abc')
  })

  it('stops at [DONE] and ignores anything after it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sseResponse(['data: {"delta":"x"}\n\ndata: [DONE]\n\ndata: {"delta":"IGNORED"}\n\n']),
      ),
    )
    const full = await streamChat([{ role: 'user', content: 'hi' }], () => {})
    expect(full).toBe('x')
  })

  it('throws on a non-OK response, surfacing the body detail', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 500 })),
    )
    await expect(streamChat([{ role: 'user', content: 'hi' }], () => {})).rejects.toThrow(
      /Chat request failed \(500\)\. nope/,
    )
  })

  it('throws when the stream carries an error event', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sseResponse(['data: {"type":"error","error":"model exploded"}\n\n']),
      ),
    )
    await expect(streamChat([{ role: 'user', content: 'hi' }], () => {})).rejects.toThrow(
      'model exploded',
    )
  })

  it('sends the auth headers and options through to the function', async () => {
    const fetchMock = vi.fn(async () => sseResponse(['data: [DONE]\n\n']))
    vi.stubGlobal('fetch', fetchMock)
    await streamChat([{ role: 'user', content: 'hi' }], () => {}, {
      system: 'be brief',
      toolIds: ['t1'],
      collectionIds: ['c1'],
    })
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://example.test/functions/v1/chat')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer test-token')
    expect(JSON.parse(init.body as string)).toMatchObject({
      system: 'be brief',
      toolIds: ['t1'],
      collectionIds: ['c1'],
    })
  })
})
