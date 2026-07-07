import { afterEach, describe, expect, it, vi } from 'vitest'
import { copyText } from './CopyButton'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('copyText', () => {
  it('uses navigator.clipboard.writeText when available', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })

    const ok = await copyText('hello world')

    expect(ok).toBe(true)
    expect(writeText).toHaveBeenCalledWith('hello world')
  })

  it('falls back to execCommand when clipboard API is missing', async () => {
    vi.stubGlobal('navigator', {})
    const exec = vi.fn().mockReturnValue(true)
    // jsdom doesn't implement execCommand; provide it.
    ;(document as unknown as { execCommand: unknown }).execCommand = exec

    const ok = await copyText('legacy path')

    expect(ok).toBe(true)
    expect(exec).toHaveBeenCalledWith('copy')
    // The temporary textarea must be cleaned up.
    expect(document.querySelector('textarea')).toBeNull()
  })

  it('falls back when clipboard.writeText rejects', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'))
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    const exec = vi.fn().mockReturnValue(true)
    ;(document as unknown as { execCommand: unknown }).execCommand = exec

    const ok = await copyText('retry')

    expect(ok).toBe(true)
    expect(exec).toHaveBeenCalledWith('copy')
  })

  it('returns false when both paths fail', async () => {
    vi.stubGlobal('navigator', {})
    ;(document as unknown as { execCommand: unknown }).execCommand = () => {
      throw new Error('nope')
    }

    const ok = await copyText('nothing')

    expect(ok).toBe(false)
  })
})
