// deno test — the pure reciprocal-rank-fusion merge that combines the vector
// (semantic) and full-text (keyword) rankings behind hybrid `search_documents`.
// Kept pure so the ranking math is verified without a DB.
import { assertAlmostEquals, assertEquals } from 'jsr:@std/assert@1'
import { hybridChunkSearch, reciprocalRankFusion, RRF_K } from '../_shared/retrieval.ts'

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

// A fake db.rpc that returns canned rows per RPC name, and records the args it saw.
function fakeDb(vector: unknown[], keyword: unknown[]) {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = []
  const db = {
    rpc(fn: string, args: Record<string, unknown>) {
      calls.push({ fn, args })
      return Promise.resolve({ data: fn === 'match_chunks_vector' ? vector : keyword })
    },
  }
  return { db, calls }
}

Deno.test('hybridChunkSearch: fuses both RPCs, dedupes, respects top', async () => {
  const { db, calls } = fakeDb(
    [{ id: 'a', content: 'A', document_name: 'd1' }, { id: 'x', content: 'X', document_name: 'd2' }],
    [{ id: 'x', content: 'X', document_name: 'd2' }, { id: 'c', content: 'C', document_name: 'd3' }],
  )
  const hits = await hybridChunkSearch(db, { embedding: [0.1], queryText: 'x', ownerId: 'u1', top: 2 })
  // 'x' is in both lists → highest fused score → first; result deduped to `top`.
  assertEquals(hits[0].id, 'x')
  assertEquals(hits.length, 2)
  // both RPCs were called with the owner + a candidate pool ≥ top
  assertEquals(calls.map((c) => c.fn).sort(), ['match_chunks_keyword', 'match_chunks_vector'])
  assertEquals(calls.every((c) => c.args.match_owner === 'u1'), true)
})

Deno.test('hybridChunkSearch: keyword empty → degrades to vector order', async () => {
  const { db } = fakeDb([{ id: 'a', content: 'A' }, { id: 'b', content: 'B' }], [])
  const hits = await hybridChunkSearch(db, { embedding: [0.1], queryText: '', ownerId: 'u1', top: 5 })
  assertEquals(hits.map((h) => h.id), ['a', 'b'])
})
