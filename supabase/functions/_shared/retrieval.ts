// Hybrid-retrieval fusion, kept pure so the ranking math is unit-tested without
// touching the DB. The knowledge base runs TWO searches over `document_chunks` —
// a pgvector cosine search (semantic) and a Postgres full-text search (keyword) —
// and this merges their rankings. Neither signal alone is enough: vector search
// misses exact terms/IDs/rare tokens that never sit near the query in embedding
// space, and keyword search misses paraphrases. Fusing them is the ~+P@5 win that
// motivated this (see the gbrain comparison).
//
// Reciprocal-rank fusion (RRF): each list is already in descending-relevance
// order; an item's fused score is Σ 1/(k + rank) over every list it appears in
// (rank is 1-based). A chunk surfaced by BOTH searches accumulates both terms and
// floats to the top — that's the whole point. RRF needs no score normalization
// across the two very different scales (cosine distance vs. ts_rank_cd), which is
// exactly why it's the standard hybrid-merge. k=60 is the value from the original
// RRF paper (Cormack et al.) and dampens how much any single top rank dominates.
export const RRF_K = 60

// Merge several already-ranked id lists into one fused ranking, best-first.
// Deterministic: ties break by first-seen order so the same inputs always give
// the same output (important for reproducible retrieval + tests).
export function reciprocalRankFusion(
  lists: string[][],
  k: number = RRF_K,
): Array<{ id: string; score: number }> {
  const scores = new Map<string, number>()
  const firstSeen = new Map<string, number>()
  let seen = 0
  for (const list of lists) {
    for (let rank = 0; rank < list.length; rank++) {
      const id = list[rank]
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + rank + 1))
      if (!firstSeen.has(id)) firstSeen.set(id, seen++)
    }
  }
  return [...scores.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score || (firstSeen.get(a.id)! - firstSeen.get(b.id)!))
}

export interface ChunkHit {
  id: string
  content: string
  document_id?: string
  document_name?: string
}

// The DB side of hybrid retrieval, in ONE place so `search_documents` (the live
// chat/agent surface) and the `rag` eval target run the exact same retrieval and
// can't drift. Runs the vector (match_chunks_vector) and keyword
// (match_chunks_keyword) RPCs in parallel over a candidate `pool` per signal,
// fuses their rankings with RRF, and returns the `top` deduped chunks. Both RPCs
// are RLS-scoped (workspace ∪ caller's private) and service-role only. `db` is
// injected (no import), so this stays trivially testable with a fake rpc.
export async function hybridChunkSearch(
  // Supabase's rpc() returns an awaitable query builder (a PromiseLike), not a
  // Promise — typing it PromiseLike keeps this accepting the real client and a
  // plain fake alike, without dragging supabase-js types into this module.
  db: { rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown }> },
  // ownerId may be null (match_owner is a nullable uuid → workspace-only scope).
  opts: { embedding: unknown; queryText: string; ownerId: string | null; top?: number; pool?: number },
): Promise<ChunkHit[]> {
  const top = Math.max(1, opts.top ?? 6)
  const pool = Math.max(opts.pool ?? 24, top)
  const [vecRes, kwRes] = await Promise.all([
    db.rpc('match_chunks_vector', { query_embedding: opts.embedding, match_owner: opts.ownerId, match_count: pool }),
    db.rpc('match_chunks_keyword', { query_text: opts.queryText, match_owner: opts.ownerId, match_count: pool }),
  ])
  const vec = (vecRes?.data ?? []) as ChunkHit[]
  const kw = (kwRes?.data ?? []) as ChunkHit[]
  const byId = new Map<string, ChunkHit>()
  for (const r of [...vec, ...kw]) if (r && !byId.has(r.id)) byId.set(r.id, r)
  const fused = reciprocalRankFusion([vec.map((r) => r.id), kw.map((r) => r.id)])
  return fused.slice(0, top).map((f) => byId.get(f.id)).filter((r): r is ChunkHit => !!r)
}
