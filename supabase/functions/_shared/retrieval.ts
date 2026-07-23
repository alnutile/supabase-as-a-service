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
  document_updated_at?: string // for citation recency / staleness ("think" mode)
}

// Source label for a citation, including recency when known, so the assistant can
// cite the document AND judge staleness ("think" mode — cite + gap analysis). E.g.
// "PII Security Program.pdf · updated 2026-06". Pure → unit-tested.
export function citationLabel(hit: { document_name?: string; document_updated_at?: string }): string {
  const name = (hit.document_name ?? '').trim() || 'document'
  const ym = String(hit.document_updated_at ?? '').slice(0, 7) // YYYY-MM
  return /^\d{4}-\d{2}$/.test(ym) ? `${name} · updated ${ym}` : name
}

// One candidate row from search_chunks_hybrid: a chunk plus its rank in the
// vector list and/or the keyword list (null = absent from that list).
interface HybridRow extends ChunkHit {
  vec_rank: number | null
  kw_rank: number | null
}

export interface HybridResult {
  hits: ChunkHit[] // fused (vector + keyword via RRF) — what we actually serve
  vector: ChunkHit[] // vector-only top-k, for the rag eval's A/B baseline
}

// The DB side of hybrid retrieval, in ONE place so `search_documents` (the live
// chat/agent surface) and the `rag` eval target run the exact same retrieval and
// can't drift. A SINGLE RPC (search_chunks_hybrid) returns the candidate pool with
// each chunk's vector-rank and keyword-rank; we fuse those two orderings with RRF
// here. One round trip (not two) keeps the per-call cost low — which matters in the
// rag eval loop, where each case runs this and a too-chatty loop tips the edge
// worker over its budget. Returns both the fused hits AND the vector-only top-k so
// the eval can score hybrid-vs-vector without a second retrieval. The RPC is
// RLS-scoped (workspace ∪ caller's private) and service-role only. `db` is injected
// (no import), so this stays trivially testable with a fake rpc.
export async function hybridChunkSearch(
  // Supabase's rpc() returns an awaitable query builder (a PromiseLike), not a
  // Promise — typing it PromiseLike keeps this accepting the real client and a
  // plain fake alike, without dragging supabase-js types into this module.
  db: { rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown }> },
  // ownerId may be null (match_owner is a nullable uuid → workspace-only scope).
  opts: { embedding: unknown; queryText: string; ownerId: string | null; top?: number; pool?: number },
): Promise<HybridResult> {
  const top = Math.max(1, opts.top ?? 6)
  const pool = Math.max(opts.pool ?? 24, top)
  const res = await db.rpc('search_chunks_hybrid', {
    query_embedding: opts.embedding,
    query_text: opts.queryText,
    match_owner: opts.ownerId,
    match_count: pool,
  })
  const rows = (res?.data ?? []) as HybridRow[]
  const byId = new Map<string, HybridRow>()
  for (const r of rows) if (r && !byId.has(r.id)) byId.set(r.id, r)
  const vecOrder = rows.filter((r) => r.vec_rank != null).sort((a, b) => a.vec_rank! - b.vec_rank!)
  const kwOrder = rows.filter((r) => r.kw_rank != null).sort((a, b) => a.kw_rank! - b.kw_rank!)
  const fused = reciprocalRankFusion([vecOrder.map((r) => r.id), kwOrder.map((r) => r.id)])
  const pick = (ids: { id: string }[] | string[]) =>
    (ids as Array<{ id: string } | string>)
      .map((x) => byId.get(typeof x === 'string' ? x : x.id))
      .filter((r): r is HybridRow => !!r)
  return {
    hits: pick(fused).slice(0, top),
    vector: pick(vecOrder.map((r) => r.id)).slice(0, top),
  }
}
