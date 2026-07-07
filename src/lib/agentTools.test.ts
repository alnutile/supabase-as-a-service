import { describe, it, expect } from 'vitest'
import { allToolsSelected, toggleAllTools } from './agentTools'

describe('allToolsSelected', () => {
  it('is false when there are no tools', () => {
    expect(allToolsSelected([], [])).toBe(false)
    expect(allToolsSelected([], ['a'])).toBe(false)
  })

  it('is true only when every tool id is selected', () => {
    expect(allToolsSelected(['a', 'b'], ['a', 'b'])).toBe(true)
    expect(allToolsSelected(['a', 'b'], ['b', 'a'])).toBe(true)
    expect(allToolsSelected(['a', 'b'], ['a'])).toBe(false)
    expect(allToolsSelected(['a', 'b'], [])).toBe(false)
  })

  it('ignores stale selections not in the tool list', () => {
    // A selection may reference tools that are no longer active.
    expect(allToolsSelected(['a', 'b'], ['a', 'b', 'gone'])).toBe(true)
    expect(allToolsSelected(['a', 'b'], ['a', 'gone'])).toBe(false)
  })
})

describe('toggleAllTools', () => {
  it('selects all when none/some are selected', () => {
    expect(toggleAllTools(['a', 'b'], [])).toEqual(['a', 'b'])
    expect(toggleAllTools(['a', 'b'], ['a'])).toEqual(['a', 'b'])
  })

  it('clears when everything is already selected', () => {
    expect(toggleAllTools(['a', 'b'], ['a', 'b'])).toEqual([])
  })

  it('selects all (dropping stale ids) when all present tools are selected', () => {
    // "all selected" including a stale id → clearing keeps behavior clean.
    expect(toggleAllTools(['a', 'b'], ['a', 'b', 'gone'])).toEqual([])
  })

  it('is a no-op returning empty when there are no tools', () => {
    expect(toggleAllTools([], [])).toEqual([])
  })
})
