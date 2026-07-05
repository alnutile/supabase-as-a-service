import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { act } from 'react'
import { ArtifactFrame } from './ArtifactFrame'

// Exercise the postMessage bridge from the iframe's side: dispatch the events
// an artifact's JS would post, and assert what the parent sends back /
// persists. jsdom gives the iframe a real contentWindow to spy on.

function getFrame(container: HTMLElement): HTMLIFrameElement {
  const iframe = container.querySelector('iframe')
  if (!iframe) throw new Error('iframe not rendered')
  return iframe
}

function postFromFrame(iframe: HTMLIFrameElement, data: unknown) {
  act(() => {
    window.dispatchEvent(
      new MessageEvent('message', { data, source: iframe.contentWindow }),
    )
  })
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('ArtifactFrame bridge', () => {
  it('replies to artifact:ready with the saved state', () => {
    const { container } = render(
      <ArtifactFrame content="<p>hi</p>" data={{ done: [1, 2] }} />,
    )
    const iframe = getFrame(container)
    const post = vi.spyOn(iframe.contentWindow!, 'postMessage')

    postFromFrame(iframe, { type: 'artifact:ready' })

    expect(post).toHaveBeenCalledWith(
      { type: 'artifact:state', data: { done: [1, 2] } },
      '*',
    )
  })

  it('debounces artifact:save bursts into one onSave with the last state', () => {
    const onSave = vi.fn()
    const { container } = render(
      <ArtifactFrame content="<p>hi</p>" data={{}} onSave={onSave} />,
    )
    const iframe = getFrame(container)

    postFromFrame(iframe, { type: 'artifact:save', data: { step: 1 } })
    postFromFrame(iframe, { type: 'artifact:save', data: { step: 2 } })
    postFromFrame(iframe, { type: 'artifact:save', data: { step: 3 } })
    expect(onSave).not.toHaveBeenCalled()

    act(() => {
      vi.advanceTimersByTime(600)
    })
    expect(onSave).toHaveBeenCalledTimes(1)
    expect(onSave).toHaveBeenCalledWith({ step: 3 })
  })

  it('flushes a pending save on unmount so the last click is not lost', () => {
    const onSave = vi.fn()
    const { container, unmount } = render(
      <ArtifactFrame content="<p>hi</p>" data={{}} onSave={onSave} />,
    )
    postFromFrame(getFrame(container), { type: 'artifact:save', data: { step: 9 } })

    unmount()
    expect(onSave).toHaveBeenCalledWith({ step: 9 })
  })

  it('ignores messages that are not from its own iframe', () => {
    const onSave = vi.fn()
    const { container } = render(
      <ArtifactFrame content="<p>hi</p>" data={{}} onSave={onSave} />,
    )
    const iframe = getFrame(container)
    const post = vi.spyOn(iframe.contentWindow!, 'postMessage')

    act(() => {
      // source: null — e.g. another window/extension posting at us.
      window.dispatchEvent(
        new MessageEvent('message', { data: { type: 'artifact:save', data: { evil: 1 } } }),
      )
      window.dispatchEvent(
        new MessageEvent('message', { data: { type: 'artifact:ready' } }),
      )
      vi.advanceTimersByTime(600)
    })

    expect(onSave).not.toHaveBeenCalled()
    expect(post).not.toHaveBeenCalled()
  })

  it('pushes an external data change into the frame, but not the echo of its own save', () => {
    const onSave = vi.fn()
    const { container, rerender } = render(
      <ArtifactFrame content="<p>hi</p>" data={{ v: 1 }} onSave={onSave} />,
    )
    const iframe = getFrame(container)
    const post = vi.spyOn(iframe.contentWindow!, 'postMessage')

    // The iframe saves v:2; the parent state then echoes v:2 back as a prop
    // (our own write coming back via realtime) — no re-send.
    postFromFrame(iframe, { type: 'artifact:save', data: { v: 2 } })
    act(() => {
      vi.advanceTimersByTime(600)
    })
    rerender(<ArtifactFrame content="<p>hi</p>" data={{ v: 2 }} onSave={onSave} />)
    expect(post).not.toHaveBeenCalled()

    // A genuinely external change (another device / the assistant) IS pushed.
    rerender(<ArtifactFrame content="<p>hi</p>" data={{ v: 3 }} onSave={onSave} />)
    expect(post).toHaveBeenCalledWith({ type: 'artifact:state', data: { v: 3 } }, '*')
  })
})
