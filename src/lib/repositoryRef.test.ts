import { describe, expect, it } from 'vitest'
import { describeSync, extractRepoId, isToolError, matchesRepoQuery, parseRepoInput, relativeTime } from './repositoryRef'

describe('parseRepoInput', () => {
  const want = { owner: 'alnutile', name: 'supanet-cli', fullName: 'alnutile/supanet-cli' }
  it('accepts urls, ssh and owner/name', () => {
    expect(parseRepoInput('https://github.com/alnutile/supanet-cli')).toEqual(want)
    expect(parseRepoInput('https://github.com/alnutile/supanet-cli.git')).toEqual(want)
    expect(parseRepoInput('github.com/alnutile/supanet-cli/tree/main')).toEqual(want)
    expect(parseRepoInput('git@github.com:alnutile/supanet-cli.git')).toEqual(want)
    expect(parseRepoInput(' alnutile/supanet-cli ')).toEqual(want)
  })
  it('rejects other hosts and partial refs', () => {
    expect(parseRepoInput('')).toBeNull()
    expect(parseRepoInput('supanet')).toBeNull()
    expect(parseRepoInput('https://gitlab.com/a/b')).toBeNull()
    expect(parseRepoInput('https://github.com/alnutile')).toBeNull()
    expect(parseRepoInput('a/b c')).toBeNull()
  })
})

describe('matchesRepoQuery', () => {
  const repo = { full_name: 'acme/billing-api', description: 'Invoices and payments', notes: 'core revenue', language: 'PHP', topics: ['laravel'] }
  it('matches across name, description, notes, language and topics', () => {
    expect(matchesRepoQuery(repo, 'billing')).toBe(true)
    expect(matchesRepoQuery(repo, 'PAYMENTS')).toBe(true)
    expect(matchesRepoQuery(repo, 'revenue')).toBe(true)
    expect(matchesRepoQuery(repo, 'php')).toBe(true)
    expect(matchesRepoQuery(repo, 'laravel')).toBe(true)
    expect(matchesRepoQuery(repo, 'rust')).toBe(false)
  })
  it('an empty query matches everything', () => {
    expect(matchesRepoQuery(repo, '   ')).toBe(true)
  })
})

describe('describeSync + relativeTime', () => {
  const now = new Date('2026-09-03T12:00:00Z')
  it('labels each state', () => {
    expect(describeSync({ last_sync_status: 'running', last_synced_at: null }, now)).toEqual({ label: 'Syncing…', tone: 'busy' })
    expect(describeSync({ last_sync_status: 'error', last_synced_at: null }, now)).toEqual({ label: 'Last sync failed', tone: 'error' })
    expect(describeSync({ last_sync_status: 'idle', last_synced_at: null }, now)).toEqual({ label: 'Not synced yet', tone: 'muted' })
    expect(describeSync({ last_sync_status: 'ok', last_synced_at: '2026-09-03T10:00:00Z' }, now)).toEqual({ label: 'Synced 2 hrs ago', tone: 'ok' })
  })
  it('relativeTime buckets minutes, hours, days, then a date', () => {
    expect(relativeTime('2026-09-03T11:59:40Z', now)).toBe('just now')
    expect(relativeTime('2026-09-03T11:30:00Z', now)).toBe('30 min ago')
    expect(relativeTime('2026-09-03T11:00:00Z', now)).toBe('1 hr ago')
    expect(relativeTime('2026-09-01T12:00:00Z', now)).toBe('2 days ago')
    expect(relativeTime('2026-06-01T12:00:00Z', now)).toBe('2026-06-01')
    expect(relativeTime('garbage', now)).toBe('')
  })
})

describe('tool result helpers', () => {
  it('extracts the id from add_repository output', () => {
    expect(extractRepoId('Connected a/b (id 0b6f1e2a-1234-4abc-9def-0123456789ab, public on GitHub).')).toBe(
      '0b6f1e2a-1234-4abc-9def-0123456789ab',
    )
    expect(extractRepoId('Could not connect a/b: 404')).toBeNull()
  })
  it('recognizes error-shaped results', () => {
    expect(isToolError('Could not connect a/b: nope')).toBe(true)
    expect(isToolError('Sync failed for a/b: rate limit')).toBe(true)
    expect(isToolError('Connected a/b (id …)')).toBe(false)
  })
})
