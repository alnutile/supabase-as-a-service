// deno test — the pure reciprocal-rank-fusion merge that combines the vector
// (semantic) and full-text (keyword) rankings behind hybrid `search_documents`.
// Kept pure so the ranking math is verified without a DB.
import { assertAlmostEquals, assertEquals } from 'jsr:@std/assert@1'
import { citationLabel, hybridChunkSearch, reciprocalRankFusion, RRF_K } from '../_shared/retrieval.ts'

Deno.test('reciprocalRankFusion: empty input → empty output', () => {
  assertEquals(reciprocalRankFusion([]), [])
  assertEquals(reciprocalRankFusion([[], []]), [])
})

Deno.test('reciprocalRankFusion: single list preserves rank order', () => {
  const out = reciprocalRankFusion([['a', 'b', 'c']])
  assertEquals(out.map((x) => x.id), ['a', 'b', 'c'])
  // score is 1/(k+rank), strictly decreasing
  assertAlmostEquals(out[0].score, 1 / (RRF_K + 1))
  assertAlmostEquals(out[1].score, 1 / (RRF_K + 2))
})

Deno.test('reciprocalRankFusion: an item in BOTH lists accumulates and floats up', () => {
  // 'x' is 2nd in vector but 1st in keyword — appearing in both should lift it
  // above 'a' (1st in vector only).
  const vector = ['a', 'x', 'b']
  const keyword = ['x', 'c']
  const out = reciprocalRankFusion([vector, keyword])
  assertEquals(out[0].id, 'x')
  // x = 1/(k+2) + 1/(k+1); a = 1/(k+1)
  const xScore = 1 / (RRF_K + 2) + 1 / (RRF_K + 1)
  assertAlmostEquals(out.find((r) => r.id === 'x')!.score, xScore)
  assertAlmostEquals(out.find((r) => r.id === 'a')!.score, 1 / (RRF_K + 1))
})

Deno.test('reciprocalRankFusion: union of all ids, deduped', () => {
  const out = reciprocalRankFusion([['a', 'b'], ['b', 'c']])
  assertEquals(new Set(out.map((r) => r.id)), new Set(['a', 'b', 'c']))
  assertEquals(out.length, 3)
})

Deno.test('reciprocalRankFusion: ties break by first-seen order (deterministic)', () => {
  // 'a' and 'b' each appear once at rank 1 of their own list → equal scores.
  // 'a' seen first, so it wins the tie.
  const out = reciprocalRankFusion([['a'], ['b']])
  assertEquals(out.map((r) => r.id), ['a', 'b'])
  assertAlmostEquals(out[0].score, out[1].score)
})

Deno.test('reciprocalRankFusion: smaller k sharpens top-rank dominance', () => {
  const ids = ['a', 'b', 'c']
  const sharp = reciprocalRankFusion([ids], 1)
  const flat = reciprocalRankFusion([ids], 1000)
  // ratio of #1 to #2 is larger when k is small
  const sharpRatio = sharp[0].score / sharp[1].score
  const flatRatio = flat[0].score / flat[1].score
  assertEquals(sharpRatio > flatRatio, true)
})

// A fake db.rpc for the single search_chunks_hybrid RPC: returns the given candidate
// rows (each carrying vec_rank / kw_rank) and records the call.
function fakeDb(rows: unknown[]) {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = []
  const db = {
    rpc(fn: string, args: Record<string, unknown>) {
      calls.push({ fn, args })
      return Promise.resolve({ data: rows })
    },
  }
  return { db, calls }
}

Deno.test('hybridChunkSearch: fuses both rankings, dedupes, returns hits + vector baseline', async () => {
  // 'x' is 2nd by vector but 1st by keyword (in both lists) → should top the fusion.
  const { db, calls } = fakeDb([
    { id: 'a', content: 'A', document_name: 'd1', vec_rank: 1, kw_rank: null },
    { id: 'x', content: 'X', document_name: 'd2', vec_rank: 2, kw_rank: 1 },
    { id: 'c', content: 'C', document_name: 'd3', vec_rank: null, kw_rank: 2 },
  ])
  const { hits, vector } = await hybridChunkSearch(db, { embedding: [0.1], queryText: 'x', ownerId: 'u1', top: 2 })
  assertEquals(hits[0].id, 'x') // fused winner (appears in both lists)
  assertEquals(hits.length, 2) // capped at top
  assertEquals(vector.map((h) => h.id), ['a', 'x']) // vector-only order, top-k
  // exactly ONE round trip, to the consolidated RPC, scoped to the owner
  assertEquals(calls.length, 1)
  assertEquals(calls[0].fn, 'search_chunks_hybrid')
  assertEquals(calls[0].args.match_owner, 'u1')
})

Deno.test('hybridChunkSearch: no keyword hits → hits degrade to vector order', async () => {
  const { db } = fakeDb([
    { id: 'a', content: 'A', vec_rank: 1, kw_rank: null },
    { id: 'b', content: 'B', vec_rank: 2, kw_rank: null },
  ])
  const { hits, vector } = await hybridChunkSearch(db, { embedding: [0.1], queryText: '', ownerId: 'u1', top: 5 })
  assertEquals(hits.map((h) => h.id), ['a', 'b'])
  assertEquals(vector.map((h) => h.id), ['a', 'b'])
})

Deno.test('citationLabel: name plus recency when a valid date is present', () => {
  assertEquals(citationLabel({ document_name: 'PII Program.pdf', document_updated_at: '2026-06-15T00:00:00Z' }), 'PII Program.pdf · updated 2026-06')
  assertEquals(citationLabel({ document_name: 'Guide.pdf' }), 'Guide.pdf')
  assertEquals(citationLabel({ document_name: '', document_updated_at: 'garbage' }), 'document')
})
