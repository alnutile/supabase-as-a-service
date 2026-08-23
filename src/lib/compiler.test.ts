import { describe, expect, it } from 'vitest'
import {
  AUTONOMY_HELP,
  DEFAULT_UI_POLICY,
  groupByKind,
  needsAttention,
  parseGuards,
  readPolicy,
  runProgress,
  statusLabel,
  statusTone,
  summarizeRun,
  writePolicy,
  type UiPolicy,
} from './compiler'

describe('status presentation', () => {
  it('tones a confirmed page as good and a contradicted one as danger', () => {
    expect(statusTone('confirmed')).toBe('good')
    expect(statusTone('contradicted')).toBe('danger')
    expect(statusTone('stale')).toBe('warn')
    expect(statusTone('compiled')).toBe('neutral')
    expect(statusTone('anything-else')).toBe('neutral')
  })

  it('labels every status readably', () => {
    expect(statusLabel('needs-review')).toBe('Needs review')
    expect(statusLabel('processing')).toBe('Compiling')
    expect(statusLabel('compiled')).toBe('Compiled')
  })

  it('only flags pages that are actually asking a question', () => {
    // A stale page is aging, not disputed — badging it would cry wolf.
    expect(needsAttention('contradicted')).toBe(true)
    expect(needsAttention('needs-review')).toBe(true)
    expect(needsAttention('stale')).toBe(false)
    expect(needsAttention('confirmed')).toBe(false)
  })

  it('explains each autonomy level in plain english', () => {
    expect(AUTONOMY_HELP.suggest).toMatch(/waits for you/i)
    expect(AUTONOMY_HELP.guarded).toMatch(/rewrites wait/i)
    expect(AUTONOMY_HELP.auto).toMatch(/wholesale/i)
  })
})

describe('policy round-trip', () => {
  it('defaults an empty blob to the guarded posture', () => {
    const p = readPolicy({})
    expect(p.autonomy).toBe('guarded')
    expect(p.enabled).toBe(true)
    expect(p.maintainKinds).toEqual(DEFAULT_UI_POLICY.maintainKinds)
  })

  it('drops unknown kinds instead of trusting them', () => {
    expect(readPolicy({ maintain_kinds: ['decision', 'bogus'] }).maintainKinds).toEqual(['decision'])
    expect(readPolicy({ compile_sources: ['file', 'bogus'] }).compileSources).toEqual(['file'])
  })

  it('falls back to defaults when nothing valid is left', () => {
    expect(readPolicy({ maintain_kinds: ['bogus'] }).maintainKinds).toEqual(DEFAULT_UI_POLICY.maintainKinds)
  })

  it('rejects an unknown autonomy level', () => {
    expect(readPolicy({ autonomy: 'freewheeling' }).autonomy).toBe('guarded')
  })

  it('clamps confidence and staleness', () => {
    const p = readPolicy({ min_confidence: 5, stale_days: 0 })
    expect(p.minConfidence).toBe(1)
    expect(p.staleDays).toBe(1)
  })

  it('survives a write/read round-trip unchanged', () => {
    const p: UiPolicy = {
      ...DEFAULT_UI_POLICY,
      autonomy: 'auto',
      neverAuto: ['financial commitments', 'client-facing'],
      minConfidence: 0.75,
      staleDays: 30,
    }
    expect(readPolicy(writePolicy(p))).toEqual(p)
  })
})

describe('parseGuards', () => {
  it('splits, trims and de-duplicates', () => {
    expect(parseGuards(' financial commitments , client-facing ,financial commitments, ')).toEqual([
      'financial commitments',
      'client-facing',
    ])
  })

  it('returns nothing for an empty field', () => {
    expect(parseGuards('   ')).toEqual([])
    expect(parseGuards(',,,')).toEqual([])
  })
})

describe('groupByKind', () => {
  const page = (id: string, kind: string) => ({ id, kind, title: id, status: 'compiled', updated_at: '' })

  it('groups in the fixed kind order so sections do not reshuffle', () => {
    const groups = groupByKind([page('a', 'project'), page('b', 'concept'), page('c', 'decision')])
    expect(groups.map((g) => g.kind)).toEqual(['concept', 'decision', 'project'])
  })

  it('drops empty kinds and buckets unknown ones last', () => {
    const groups = groupByKind([page('a', 'concept'), page('b', 'mystery')])
    expect(groups.map((g) => g.kind)).toEqual(['concept', 'other'])
    expect(groups[1].pages).toHaveLength(1)
  })

  it('returns nothing for no pages', () => {
    expect(groupByKind([])).toEqual([])
  })
})

describe('summarizeRun', () => {
  const base = { status: 'ok', sources_seen: 3, started_at: '' }

  it('lists only the non-zero counts', () => {
    expect(summarizeRun({ ...base, counts: { created: 2, updated: 0, conflicts: 1 } }))
      .toBe('2 created · 1 conflict')
  })

  it('pluralizes conflicts', () => {
    expect(summarizeRun({ ...base, counts: { conflicts: 2 } })).toBe('2 conflicts')
  })

  it('distinguishes "no changes" from "nothing new"', () => {
    expect(summarizeRun({ ...base, counts: {} })).toBe('No changes')
    expect(summarizeRun({ ...base, sources_seen: 0, counts: {} })).toBe('Nothing new to compile')
  })

  it('reports a running pass and a failure', () => {
    expect(summarizeRun({ ...base, status: 'running', counts: null })).toBe('Compiling…')
    expect(summarizeRun({ ...base, status: 'error', counts: null, error: 'boom' })).toBe('Failed: boom')
    expect(summarizeRun({ ...base, status: 'error', counts: null })).toBe('Failed')
  })

  it('tolerates a null counts blob', () => {
    expect(summarizeRun({ ...base, counts: null })).toBe('No changes')
  })
})

describe('runProgress', () => {
  it('counts done and skipped steps as complete', () => {
    expect(
      runProgress([{ state: 'done' }, { state: 'skipped' }, { state: 'running' }, { state: 'pending' }]),
    ).toBe(0.5)
  })

  it('is zero for a missing or empty checklist', () => {
    expect(runProgress(null)).toBe(0)
    expect(runProgress([])).toBe(0)
    expect(runProgress('nonsense')).toBe(0)
  })
})
