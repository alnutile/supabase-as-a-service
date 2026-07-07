import { describe, expect, it } from 'vitest'
import {
  allNavItems,
  flaggableGroups,
  isFeatureEnabled,
  navGroups,
  settingsGroup,
  visibleGroups,
  type NavItem,
} from './nav'

const item = (over: Partial<NavItem> = {}): NavItem => ({
  to: '/x',
  label: 'X',
  key: 'x',
  icon: () => null as unknown as JSX.Element,
  ...over,
})

describe('isFeatureEnabled', () => {
  it('defaults to enabled when there is no flag', () => {
    expect(isFeatureEnabled(item({ key: 'inbox' }), {})).toBe(true)
  })

  it('is disabled only when a flag is explicitly false', () => {
    expect(isFeatureEnabled(item({ key: 'inbox' }), { inbox: false })).toBe(false)
    expect(isFeatureEnabled(item({ key: 'inbox' }), { inbox: true })).toBe(true)
  })

  it('alwaysOn items ignore a disabling flag (no lockout)', () => {
    expect(isFeatureEnabled(item({ key: 'chat', alwaysOn: true }), { chat: false })).toBe(true)
  })
})

describe('visibleGroups', () => {
  it('hides admin-only items from non-admins', () => {
    const groups = [{ label: 'G', items: [item({ key: 'a' }), item({ key: 'b', adminOnly: true })] }]
    const asMember = visibleGroups(groups, { flags: {}, isAdmin: false })
    expect(asMember[0].items.map((i) => i.key)).toEqual(['a'])
    const asAdmin = visibleGroups(groups, { flags: {}, isAdmin: true })
    expect(asAdmin[0].items.map((i) => i.key)).toEqual(['a', 'b'])
  })

  it('hides feature-flagged items for everyone', () => {
    const groups = [{ label: 'G', items: [item({ key: 'a' }), item({ key: 'b' })] }]
    const out = visibleGroups(groups, { flags: { b: false }, isAdmin: true })
    expect(out[0].items.map((i) => i.key)).toEqual(['a'])
  })

  it('drops groups left with no visible items', () => {
    const groups = [{ label: 'G', items: [item({ key: 'a' })] }]
    expect(visibleGroups(groups, { flags: { a: false }, isAdmin: true })).toEqual([])
  })
})

describe('nav config invariants', () => {
  it('every item key is unique', () => {
    const keys = allNavItems().map((i) => i.key)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('flaggableGroups excludes alwaysOn items and the whole Settings section', () => {
    const flaggableKeys = flaggableGroups().flatMap((g) => g.items.map((i) => i.key))
    // Core items are never flaggable.
    expect(flaggableKeys).not.toContain('home')
    expect(flaggableKeys).not.toContain('chat')
    // Settings items are alwaysOn and live outside navGroups → never flaggable.
    for (const s of settingsGroup.items) expect(flaggableKeys).not.toContain(s.key)
    // A regular feature area is flaggable.
    expect(flaggableKeys).toContain('inbox')
    expect(flaggableKeys).toContain('tables')
  })

  it('navGroups Settings is not duplicated inside the feature areas', () => {
    expect(navGroups.some((g) => g.label === 'Settings')).toBe(false)
  })
})
