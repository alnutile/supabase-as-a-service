// Unit tests for the knowledge compiler's pure core.
//
// The trust boundary (classifyUpdate) gets the most attention on purpose: it is
// the one function standing between "new evidence arrived" and "the machine
// rewrote a page nobody re-read". Compilation amplifies mistakes, so these
// assertions are the safety net for that amplification.
import { assert, assertEquals, assertStringIncludes } from 'https://deno.land/std@0.208.0/assert/mod.ts'
import {
  applyUpdateToContent,
  briefCounts,
  buildCompilerPrompt,
  claimFingerprint,
  classifyUpdate,
  compiledContextBlock,
  DEFAULT_POLICY,
  dedupeClaims,
  formatChangeBrief,
  formatConflict,
  freshnessOf,
  isProtected,
  isQuietRun,
  matchPage,
  normalizePolicy,
  pageKey,
  parseCompilerOutput,
  policyToJson,
  stalePageKeys,
  type CompiledPage,
  type CompilePolicy,
  type PageUpdate,
} from '../_shared/compiler.ts'

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function page(over: Partial<CompiledPage> = {}): CompiledPage {
  return {
    id: 'p1',
    key: 'payment-schedule',
    kind: 'decision',
    title: 'Payment schedule',
    content: 'Payments are monthly.',
    status: 'compiled',
    confidence: 0.8,
    humanConfirmed: false,
    labels: [],
    lastReviewedAt: null,
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...over,
  }
}

function update(over: Partial<PageUpdate> = {}): PageUpdate {
  return {
    op: 'append',
    pageKey: 'payment-schedule',
    kind: 'decision',
    title: 'Payment schedule',
    body: 'Payments moved to biweekly.',
    reason: 'new contract',
    confidence: 0.9,
    conflictsWith: [],
    sourceIds: ['s1'],
    ...over,
  }
}

function policy(over: Partial<CompilePolicy> = {}): CompilePolicy {
  return { ...DEFAULT_POLICY, ...over }
}

// ---------------------------------------------------------------------------
// keys and fingerprints
// ---------------------------------------------------------------------------

Deno.test('pageKey slugs a title stably across case and punctuation', () => {
  assertEquals(pageKey('Payment Schedule'), 'payment-schedule')
  assertEquals(pageKey('  payment schedule!  '), 'payment-schedule')
  assertEquals(pageKey('Payment — Schedule'), 'payment-schedule')
})

Deno.test('pageKey strips diacritics so accented titles do not fork a page', () => {
  assertEquals(pageKey('Café Process'), 'cafe-process')
})

Deno.test('pageKey caps length and never leaves stray dashes', () => {
  const key = pageKey('a'.repeat(200))
  assertEquals(key.length, 80)
  assert(!key.startsWith('-') && !key.endsWith('-'))
})

Deno.test('claimFingerprint collapses case, punctuation and whitespace', () => {
  assertEquals(
    claimFingerprint('The deadline is  March 3rd.'),
    claimFingerprint('the deadline is march 3rd'),
  )
})

Deno.test('dedupeClaims drops already-stored and in-batch duplicates', () => {
  const claims = [
    { statement: 'Payments are biweekly', pageKey: null, kind: null, confidence: 0.9, sourceId: 's1' },
    { statement: 'payments are biweekly!', pageKey: null, kind: null, confidence: 0.9, sourceId: 's2' },
    { statement: 'The client is Acme', pageKey: null, kind: null, confidence: 0.9, sourceId: 's1' },
  ]
  const out = dedupeClaims(claims, [claimFingerprint('The client is Acme')])
  assertEquals(out.length, 1)
  assertEquals(out[0].statement, 'Payments are biweekly')
})

// ---------------------------------------------------------------------------
// policy normalization — an allow-list must never widen on bad input
// ---------------------------------------------------------------------------

Deno.test('normalizePolicy fills defaults for an empty blob', () => {
  const p = normalizePolicy({})
  assertEquals(p.autonomy, 'guarded')
  assertEquals(p.enabled, true)
  assert(p.maintainKinds.includes('decision'))
})

Deno.test('normalizePolicy drops unknown kinds rather than trusting them', () => {
  const p = normalizePolicy({ maintain_kinds: ['decision', 'nonsense'], compile_sources: ['file', 'telepathy'] })
  assertEquals(p.maintainKinds, ['decision'])
  assertEquals(p.compileSources, ['file'])
})

Deno.test('normalizePolicy falls back to defaults when every entry is invalid', () => {
  const p = normalizePolicy({ maintain_kinds: ['nope'] })
  assertEquals(p.maintainKinds, DEFAULT_POLICY.maintainKinds)
})

Deno.test('normalizePolicy rejects an unknown autonomy level', () => {
  assertEquals(normalizePolicy({ autonomy: 'yolo' }).autonomy, 'guarded')
})

Deno.test('normalizePolicy clamps confidence and staleness into range', () => {
  const p = normalizePolicy({ min_confidence: 9, stale_days: -4 })
  assertEquals(p.minConfidence, 1)
  assertEquals(p.staleDays, 1)
})

Deno.test('policyToJson round-trips through normalizePolicy', () => {
  const p = policy({ autonomy: 'auto', neverAuto: ['financial commitments'], minConfidence: 0.7 })
  assertEquals(normalizePolicy(policyToJson(p)), p)
})

// ---------------------------------------------------------------------------
// parsing the model's output — fails closed
// ---------------------------------------------------------------------------

Deno.test('parseCompilerOutput reads a fenced JSON reply', () => {
  const reply = '```json\n{"claims":[{"statement":"Payments are biweekly","confidence":0.9}],"updates":[]}\n```'
  const { ok, output, error } = parseCompilerOutput(reply)
  assert(ok)
  assertEquals(error, null)
  assertEquals(output.claims.length, 1)
})

Deno.test('parseCompilerOutput fails closed on unparseable output', () => {
  const { ok, output, error } = parseCompilerOutput('I could not do that, sorry.')
  assertEquals(ok, false)
  assertEquals(output.updates.length, 0)
  assert(error)
})

Deno.test('parseCompilerOutput fails closed on malformed JSON', () => {
  const { ok, output } = parseCompilerOutput('{"claims": [oops}')
  assertEquals(ok, false)
  assertEquals(output.claims.length, 0)
})

Deno.test('parseCompilerOutput normalizes op, kind and page_key', () => {
  const { output } = parseCompilerOutput(JSON.stringify({
    updates: [{ op: 'REVISE', kind: 'Decision', title: 'Payment Schedule', body: 'biweekly' }],
  }))
  assertEquals(output.updates[0].op, 'revise')
  assertEquals(output.updates[0].kind, 'decision')
  assertEquals(output.updates[0].pageKey, 'payment-schedule')
})

Deno.test('parseCompilerOutput defaults an unknown op to the additive one', () => {
  const { output } = parseCompilerOutput(JSON.stringify({
    updates: [{ op: 'obliterate', kind: 'decision', title: 'X', body: 'y' }],
  }))
  assertEquals(output.updates[0].op, 'append')
})

Deno.test('parseCompilerOutput drops an update with no body', () => {
  const { output } = parseCompilerOutput(JSON.stringify({ updates: [{ title: 'X', kind: 'decision' }] }))
  assertEquals(output.updates.length, 0)
})

Deno.test('parseCompilerOutput clamps confidence into 0..1', () => {
  const { output } = parseCompilerOutput(JSON.stringify({
    claims: [{ statement: 'a', confidence: 42 }, { statement: 'b', confidence: -3 }],
  }))
  assertEquals(output.claims[0].confidence, 1)
  assertEquals(output.claims[1].confidence, 0)
})

Deno.test('parseCompilerOutput reads conflicts with a defaulted severity', () => {
  const { output } = parseCompilerOutput(JSON.stringify({
    conflicts: [{ existing: 'monthly', incoming: 'biweekly', severity: 'catastrophic' }],
  }))
  assertEquals(output.conflicts.length, 1)
  assertEquals(output.conflicts[0].severity, 'medium')
})

Deno.test('parseCompilerOutput accepts the page_updates alias', () => {
  const { output } = parseCompilerOutput(JSON.stringify({
    page_updates: [{ op: 'append', kind: 'concept', title: 'T', body: 'b' }],
  }))
  assertEquals(output.updates.length, 1)
})

// ---------------------------------------------------------------------------
// matching an update to a page
// ---------------------------------------------------------------------------

Deno.test('matchPage finds the page by its stable key', () => {
  assertEquals(matchPage(update(), [page()])?.id, 'p1')
})

Deno.test('matchPage falls back to a normalized title match', () => {
  const u = update({ pageKey: 'something-else', title: 'Payment Schedule' })
  assertEquals(matchPage(u, [page()])?.id, 'p1')
})

Deno.test('matchPage returns null for a genuinely new page', () => {
  assertEquals(matchPage(update({ pageKey: 'vendor-list', title: 'Vendor list' }), [page()]), null)
})

Deno.test('matchPage does not cross page kinds on a fuzzy match', () => {
  const u = update({ pageKey: 'payment', title: 'Payment', kind: 'process' })
  assertEquals(matchPage(u, [page()]), null)
})

// ---------------------------------------------------------------------------
// THE TRUST BOUNDARY
// ---------------------------------------------------------------------------

Deno.test('classifyUpdate applies an additive append under the default policy', () => {
  const v = classifyUpdate(update(), page(), policy())
  assertEquals(v.decision, 'apply')
})

Deno.test('classifyUpdate holds a rewrite under guarded autonomy', () => {
  const v = classifyUpdate(update({ op: 'revise' }), page(), policy())
  assertEquals(v.decision, 'review')
  assertStringIncludes(v.reason, 'guarded')
})

Deno.test('classifyUpdate applies a rewrite once autonomy is auto', () => {
  const v = classifyUpdate(update({ op: 'revise' }), page(), policy({ autonomy: 'auto' }))
  assertEquals(v.decision, 'apply')
})

Deno.test('classifyUpdate never applies a wholesale supersede, even on auto', () => {
  const v = classifyUpdate(update({ op: 'supersede' }), page(), policy({ autonomy: 'auto' }))
  assertEquals(v.decision, 'review')
  assertStringIncludes(v.reason, 'wholesale')
})

Deno.test('classifyUpdate sends everything to review under suggest autonomy', () => {
  const v = classifyUpdate(update({ op: 'append' }), page(), policy({ autonomy: 'suggest' }))
  assertEquals(v.decision, 'review')
})

Deno.test('classifyUpdate reviews anything that contradicts compiled knowledge', () => {
  const v = classifyUpdate(update({ conflictsWith: ['payment-schedule'] }), page(), policy({ autonomy: 'auto' }))
  assertEquals(v.decision, 'review')
  assertStringIncludes(v.reason, 'contradicts')
})

Deno.test('classifyUpdate reviews a page guarded by the never-auto policy', () => {
  const p = policy({ autonomy: 'auto', neverAuto: ['financial commitments'] })
  const target = page({ labels: ['financial commitments'] })
  assertEquals(classifyUpdate(update(), target, p).decision, 'review')
})

Deno.test('never-auto matches on kind and on a title substring too', () => {
  assert(isProtected(page({ kind: 'decision' }), policy({ neverAuto: ['decision'] })))
  assert(isProtected(page({ title: 'Client-facing pricing sheet' }), policy({ neverAuto: ['client-facing'] })))
  assert(!isProtected(page(), policy({ neverAuto: ['unrelated'] })))
})

Deno.test('a human-confirmed page can still be appended to but not rewritten', () => {
  const p = policy({ autonomy: 'auto' })
  const confirmed = page({ humanConfirmed: true })
  assertEquals(classifyUpdate(update({ op: 'append' }), confirmed, p).decision, 'apply')
  const rewrite = classifyUpdate(update({ op: 'revise' }), confirmed, p)
  assertEquals(rewrite.decision, 'review')
  assertStringIncludes(rewrite.reason, 'human-confirmed')
})

Deno.test('classifyUpdate reviews an update below the confidence threshold', () => {
  const v = classifyUpdate(update({ confidence: 0.2 }), page(), policy())
  assertEquals(v.decision, 'review')
  assertStringIncludes(v.reason, 'threshold')
})

Deno.test('classifyUpdate blocks a kind this collection does not maintain', () => {
  const v = classifyUpdate(update({ kind: 'person' }), null, policy({ maintainKinds: ['decision'] }))
  assertEquals(v.decision, 'blocked')
})

Deno.test('classifyUpdate blocks everything when compilation is off', () => {
  assertEquals(classifyUpdate(update(), page(), policy({ enabled: false })).decision, 'blocked')
})

Deno.test('creating a brand-new page is allowed under guarded autonomy', () => {
  const v = classifyUpdate(update({ op: 'create', pageKey: 'vendor-list', title: 'Vendor list' }), null, policy())
  assertEquals(v.decision, 'apply')
})

Deno.test('a create against an existing page degrades to an append, not a clobber', () => {
  // The model asking to "create" a page that already exists must never wipe it.
  const v = classifyUpdate(update({ op: 'create' }), page({ humanConfirmed: true }), policy())
  assertEquals(v.decision, 'apply')
})

Deno.test('a revise with no page to revise is treated as a create', () => {
  const v = classifyUpdate(update({ op: 'revise', pageKey: 'new-thing', title: 'New thing' }), null, policy())
  assertEquals(v.decision, 'apply')
})

// ---------------------------------------------------------------------------
// applying content
// ---------------------------------------------------------------------------

Deno.test('applyUpdateToContent appends under a dated marker and keeps the old text', () => {
  const out = applyUpdateToContent(page(), update({ op: 'append', body: 'Now biweekly.' }), new Date('2026-08-22T00:00:00Z'))
  assertStringIncludes(out, 'Payments are monthly.')
  assertStringIncludes(out, 'Now biweekly.')
  assertStringIncludes(out, 'compiled 2026-08-22')
})

Deno.test('applyUpdateToContent replaces the body on a revise', () => {
  const out = applyUpdateToContent(page(), update({ op: 'revise', body: 'Payments are biweekly.' }), new Date())
  assertEquals(out, 'Payments are biweekly.')
})

Deno.test('applyUpdateToContent uses the body verbatim for a new page', () => {
  assertEquals(applyUpdateToContent(null, update({ op: 'create', body: 'Fresh.' }), new Date()), 'Fresh.')
})

// ---------------------------------------------------------------------------
// staleness
// ---------------------------------------------------------------------------

Deno.test('freshnessOf grades a page by age', () => {
  const now = new Date('2026-08-22T00:00:00Z')
  assertEquals(freshnessOf(page({ updatedAt: '2026-08-20T00:00:00Z' }), now, 90), 'fresh')
  assertEquals(freshnessOf(page({ updatedAt: '2026-06-01T00:00:00Z' }), now, 90), 'aging')
  assertEquals(freshnessOf(page({ updatedAt: '2026-01-01T00:00:00Z' }), now, 90), 'stale')
})

Deno.test('freshnessOf measures from the last human review when there is one', () => {
  const now = new Date('2026-08-22T00:00:00Z')
  // The compiler touched it yesterday, but a human has not looked since January.
  const p = page({ updatedAt: '2026-08-21T00:00:00Z', lastReviewedAt: '2026-01-01T00:00:00Z' })
  assertEquals(freshnessOf(p, now, 90), 'stale')
})

Deno.test('freshnessOf treats an unparseable timestamp as stale', () => {
  assertEquals(freshnessOf(page({ updatedAt: 'nonsense', lastReviewedAt: null }), new Date(), 90), 'stale')
})

Deno.test('stalePageKeys skips pages already stale or archived', () => {
  const now = new Date('2026-08-22T00:00:00Z')
  const old = '2026-01-01T00:00:00Z'
  const keys = stalePageKeys(
    [
      page({ key: 'a', updatedAt: old }),
      page({ key: 'b', updatedAt: old, status: 'stale' }),
      page({ key: 'c', updatedAt: old, status: 'archived' }),
      page({ key: 'd', updatedAt: '2026-08-21T00:00:00Z' }),
    ],
    now,
    90,
  )
  assertEquals(keys, ['a'])
})

// ---------------------------------------------------------------------------
// the prompt contract
// ---------------------------------------------------------------------------

Deno.test('buildCompilerPrompt states the no-invention and no-winner rules', () => {
  const prompt = buildCompilerPrompt({
    collectionName: 'Money Plan',
    policy: policy(),
    pages: [page()],
    terms: [{ term: 'APR', definition: 'annual percentage rate' }],
    sources: [{ kind: 'file', id: 's1', label: 'contract.pdf', capturedAt: '2026-08-22', text: 'Biweekly payments.' }],
  })
  assertStringIncludes(prompt, 'Money Plan')
  assertStringIncludes(prompt, 'Never invent')
  assertStringIncludes(prompt, 'DO NOT pick a winner')
  assertStringIncludes(prompt, 'evidence')
  assertStringIncludes(prompt, 'SOURCE s1')
  assertStringIncludes(prompt, 'APR')
})

Deno.test('buildCompilerPrompt lists only the kinds this collection maintains', () => {
  const prompt = buildCompilerPrompt({
    collectionName: 'C',
    policy: policy({ maintainKinds: ['decision'] }),
    pages: [],
    terms: [],
    sources: [],
  })
  assertStringIncludes(prompt, 'maintained here: decision')
  assertStringIncludes(prompt, 'first pass')
})

Deno.test('buildCompilerPrompt budgets long sources instead of blowing the window', () => {
  const prompt = buildCompilerPrompt({
    collectionName: 'C',
    policy: policy(),
    pages: [],
    terms: [],
    sources: [
      { kind: 'file', id: 's1', label: 'a', capturedAt: '2026-08-22', text: 'x'.repeat(50_000) },
      { kind: 'file', id: 's2', label: 'b', capturedAt: '2026-08-22', text: 'y'.repeat(50_000) },
    ],
    sourceBudget: 2000,
  })
  assertStringIncludes(prompt, '[truncated]')
  assert(prompt.length < 12_000)
})

// ---------------------------------------------------------------------------
// the change brief
// ---------------------------------------------------------------------------

const BRIEF = {
  collectionName: 'Money Plan',
  startedAt: '2026-08-22T09:00:00.000Z',
  sourcesSeen: 3,
  created: [{ title: 'Vendor list', kind: 'concept' }],
  updated: [{ title: 'Payment schedule', op: 'append' }],
  review: [{ title: 'Budget projection', reason: 'human-confirmed page' }],
  conflicts: [
    {
      pageKey: 'payment-schedule',
      existing: 'Money Plan assumes monthly payments.',
      incoming: 'Payment schedule changed to biweekly.',
      impact: 'Budget projections may be incorrect.',
      suggestedAction: 'Confirm which schedule is current.',
      severity: 'high' as const,
      sourceIds: ['s1'],
    },
  ],
  stale: ['old-assumptions'],
  linked: 4,
  claims: 12,
}

Deno.test('briefCounts summarizes a run', () => {
  assertEquals(briefCounts(BRIEF), {
    created: 1, updated: 1, review: 1, conflicts: 1, stale: 1, linked: 4, claims: 12, sources: 3,
  })
})

Deno.test('isQuietRun is true only when nothing changed', () => {
  assert(isQuietRun({ created: 0, updated: 0, review: 0, conflicts: 0, stale: 0, linked: 0, claims: 5, sources: 2 }))
  assert(!isQuietRun(briefCounts(BRIEF)))
})

Deno.test('formatConflict renders the explicit human-facing form', () => {
  const text = formatConflict(BRIEF.conflicts[0])
  assertStringIncludes(text, 'CONFLICT DETECTED')
  assertStringIncludes(text, 'New source:')
  assertStringIncludes(text, 'Existing knowledge:')
  assertStringIncludes(text, 'Impact:')
  assertStringIncludes(text, 'Suggested action:')
})

Deno.test('formatConflict fills in a default action when none was suggested', () => {
  const text = formatConflict({ ...BRIEF.conflicts[0], suggestedAction: '', impact: '' })
  assertStringIncludes(text, 'Confirm which source is current.')
})

Deno.test('formatChangeBrief leads with conflicts and covers every section', () => {
  const brief = formatChangeBrief(BRIEF)
  assertStringIncludes(brief, '# Change brief — Money Plan')
  assertStringIncludes(brief, '## Conflicts — needs your decision')
  assertStringIncludes(brief, '## Held for review')
  assertStringIncludes(brief, '## Added')
  assertStringIncludes(brief, '## Updated')
  assertStringIncludes(brief, '## Now stale')
  assertStringIncludes(brief, '12 claims recorded with provenance')
  // Conflicts must come before the routine sections.
  assert(brief.indexOf('## Conflicts') < brief.indexOf('## Added'))
})

Deno.test('formatChangeBrief renders an empty run without crashing', () => {
  const brief = formatChangeBrief({
    collectionName: 'C', startedAt: '2026-08-22T00:00:00.000Z', sourcesSeen: 0,
    created: [], updated: [], review: [], conflicts: [], stale: [], linked: 0, claims: 0,
  })
  assertStringIncludes(brief, '- (none)')
  assert(!brief.includes('## Conflicts'))
})

// ---------------------------------------------------------------------------
// compiled-first context
// ---------------------------------------------------------------------------

Deno.test('compiledContextBlock tells the model to answer from compiled pages first', () => {
  const block = compiledContextBlock('Money Plan', [page()])
  assertStringIncludes(block, 'MAINTAINED understanding')
  assertStringIncludes(block, 'Answer from this first')
  assertStringIncludes(block, 'evidence behind these pages')
  assertStringIncludes(block, 'Payments are monthly.')
})

Deno.test('compiledContextBlock flags disputed and stale pages instead of asserting them', () => {
  const block = compiledContextBlock('C', [
    page({ key: 'a', title: 'A', status: 'contradicted' }),
    page({ key: 'b', title: 'B', status: 'stale' }),
  ])
  assertStringIncludes(block, 'contradicted')
  assertStringIncludes(block, 'stale')
})

Deno.test('compiledContextBlock puts human-confirmed pages first', () => {
  const block = compiledContextBlock('C', [
    page({ key: 'a', title: 'Unconfirmed', updatedAt: '2026-08-21T00:00:00Z' }),
    page({ key: 'b', title: 'Confirmed', humanConfirmed: true, updatedAt: '2026-01-01T00:00:00Z' }),
  ])
  assert(block.indexOf('Confirmed') < block.indexOf('Unconfirmed'))
})

Deno.test('compiledContextBlock is empty when nothing is compiled', () => {
  assertEquals(compiledContextBlock('C', []), '')
  assertEquals(compiledContextBlock('C', [page({ content: '   ' })]), '')
})

Deno.test('compiledContextBlock respects its character budget', () => {
  const pages = Array.from({ length: 50 }, (_, i) => page({ key: `p${i}`, title: `P${i}`, content: 'z'.repeat(1000) }))
  const block = compiledContextBlock('C', pages, 3000)
  assert(block.length < 5000)
})

Deno.test('compiledContextBlock skips archived pages', () => {
  assertEquals(compiledContextBlock('C', [page({ status: 'archived' })]), '')
})
