import { describe, expect, it } from 'vitest'
import { canReindex, reindexActionLabel, reindexDocPatch } from './documents'

describe('reindexDocPatch', () => {
  it('resets a doc to a fresh pending state', () => {
    expect(reindexDocPatch()).toEqual({ status: 'pending', error: null, chunk_count: 0 })
  })

  it('clears any prior error message', () => {
    expect(reindexDocPatch().error).toBeNull()
  })
})

describe('canReindex', () => {
  it('offers re-index for every known status, including stuck ones', () => {
    for (const s of ['pending', 'processing', 'done', 'error']) {
      expect(canReindex(s)).toBe(true)
    }
  })

  it('does not offer re-index without a doc or for an unknown status', () => {
    expect(canReindex(undefined)).toBe(false)
    expect(canReindex(null)).toBe(false)
    expect(canReindex('')).toBe(false)
    expect(canReindex('archived')).toBe(false)
  })
})

describe('reindexActionLabel', () => {
  it('says "Retry indexing" on a failed doc', () => {
    expect(reindexActionLabel('error')).toBe('Retry indexing')
  })

  it('says "Re-index" otherwise', () => {
    expect(reindexActionLabel('done')).toBe('Re-index')
    expect(reindexActionLabel('pending')).toBe('Re-index')
    expect(reindexActionLabel('processing')).toBe('Re-index')
    expect(reindexActionLabel(undefined)).toBe('Re-index')
  })
})
