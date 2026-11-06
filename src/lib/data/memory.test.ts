import { describe, expect, it } from 'vitest'
import { runBackendContract } from './contract'
import { createMemoryBackend } from './memory'
import { data, getBackend, setBackend } from './index'

runBackendContract('memory', () => createMemoryBackend())

describe('data facade', () => {
  it('forwards to whichever backend is current', async () => {
    const mem = createMemoryBackend()
    setBackend(mem)
    expect(getBackend()).toBe(mem)
    await data.terminology.create({ term: 'seam', definition: 'where backends swap' })
    expect((await mem.terminology.list()).map((t) => t.term)).toEqual(['seam'])
  })
})
