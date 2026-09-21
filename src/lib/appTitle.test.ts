import { describe, expect, it } from 'vitest'
import { APP_NAME, appTitle } from './appTitle'

describe('appTitle', () => {
  it('falls back to the app name when no organization is set', () => {
    expect(appTitle()).toBe(APP_NAME)
    expect(appTitle(null)).toBe(APP_NAME)
    expect(appTitle('')).toBe(APP_NAME)
    expect(appTitle('   ')).toBe(APP_NAME)
  })

  it('leads with the organization name', () => {
    expect(appTitle('Acme Corp')).toBe('Acme Corp · SupaNet')
  })

  it('normalizes whitespace', () => {
    expect(appTitle('  Acme\n Corp  ')).toBe('Acme Corp · SupaNet')
  })

  it('does not repeat the app name', () => {
    expect(appTitle('SupaNet')).toBe(APP_NAME)
    expect(appTitle('supanet')).toBe(APP_NAME)
  })

  it('clips a very long name so the app name stays visible', () => {
    const long = 'A'.repeat(120)
    const title = appTitle(long)
    expect(title.endsWith(' · SupaNet')).toBe(true)
    expect(title).toBe(`${'A'.repeat(59)}…${' · SupaNet'}`)
  })
})
