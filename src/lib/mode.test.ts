import { describe, expect, it } from 'vitest'
import { isLocalReady, LOCAL_HOME } from './mode'

describe('isLocalReady', () => {
  it('matches a ready route and its sub-routes only', () => {
    expect(isLocalReady('/terminology')).toBe(true)
    expect(isLocalReady('/terminology/abc')).toBe(true)
    expect(isLocalReady('/terminologyx')).toBe(false)
    expect(isLocalReady('/chat')).toBe(false)
    expect(isLocalReady('/')).toBe(false)
  })

  it('lands on a ready route', () => {
    expect(isLocalReady(LOCAL_HOME)).toBe(true)
  })
})
