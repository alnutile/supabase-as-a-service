import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'

// One channel per TOPIC is what supabase-js actually does: ask for a topic it
// already holds and you get that same channel back. `.on()` on one that has
// already subscribed throws — which is what blanked the app when this hook
// created its channel per-component and was mounted twice (Layout + HomePage).
// The fake below reproduces that contract, so a regression crashes this test.
const channels = new Map<string, FakeChannel>()
let selects = 0

class FakeChannel {
  subscribed = false
  on() {
    if (this.subscribed) {
      throw new Error('cannot add `postgres_changes` callbacks after `subscribe()`.')
    }
    return this
  }
  subscribe() {
    this.subscribed = true
    return this
  }
}

vi.mock('./supabase', () => ({
  supabase: {
    channel: (topic: string) => {
      const existing = channels.get(topic)
      if (existing) return existing
      const created = new FakeChannel()
      channels.set(topic, created)
      return created
    },
    removeChannel: (ch: FakeChannel) => {
      for (const [topic, value] of channels) if (value === ch) channels.delete(topic)
    },
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: () => {
            selects += 1
            return Promise.resolve({ data: { value: '  Acme Corp  ' } })
          },
        }),
      }),
    }),
  },
}))

const { useOrganizationName } = await import('./useOrganizationName')

function Consumer({ label }: { label: string }) {
  const orgName = useOrganizationName()
  return <span data-testid={label}>{orgName}</span>
}

beforeEach(() => {
  channels.clear()
  selects = 0
})
afterEach(cleanup)

describe('useOrganizationName', () => {
  it('opens one channel and fetches once no matter how many components mount it', async () => {
    render(
      <>
        <Consumer label="a" />
        <Consumer label="b" />
      </>,
    )
    // The bug: the second mount threw on `.on()` and took the tree down.
    expect(channels.size).toBe(1)
    expect(selects).toBe(1)
    await waitFor(() => expect(screen.getByTestId('a').textContent).toBe('Acme Corp'))
    expect(screen.getByTestId('b').textContent).toBe('Acme Corp')
  })

  it('trims the stored value and shares it with every consumer', async () => {
    render(<Consumer label="only" />)
    await waitFor(() => expect(screen.getByTestId('only').textContent).toBe('Acme Corp'))
  })

  it('releases the channel once the last consumer unmounts', async () => {
    const view = render(<Consumer label="a" />)
    await waitFor(() => expect(channels.size).toBe(1))
    view.unmount()
    expect(channels.size).toBe(0)
  })
})
