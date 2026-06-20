// Shared knowledge-ingestion primitive: turn raw text into searchable chunks in
// the workspace knowledge base. This is the ONE door every source funnels
// through — uploaded PDFs (the `ingest` cron, after it extracts the text layer)
// and pushed notes (the `add_note` MCP tool) both end up here, so adding new
// front doors later (a webhook sink, per-user Granola) means wiring a source to
// this, not re-implementing chunk → embed → store. Embedding is free + in-edge
// via the gte-small model (384 dims), matching `search_documents`.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4'

type DB = ReturnType<typeof createClient>

const CHUNK_SIZE = 1500
const CHUNK_OVERLAP = 200
const MAX_CHUNKS = 200

// Sliding-window chunker: collapse whitespace, then ~1500-char windows with a
// 200-char overlap, dropping trivially short tails.
export function chunkText(text: string): string[] {
  const clean = text.replace(/\s+/g, ' ').trim()
  const out: string[] = []
  let i = 0
  while (i < clean.length && out.length < MAX_CHUNKS) {
    out.push(clean.slice(i, i + CHUNK_SIZE))
    i += CHUNK_SIZE - CHUNK_OVERLAP
  }
  return out.filter((c) => c.trim().length > 20)
}

// Embed each chunk with the free in-edge gte-small model and (re)write the rows
// for one document. Returns how many chunks were stored.
export async function embedAndStore(
  db: DB,
  documentId: string,
  ownerId: string,
  chunks: string[],
): Promise<number> {
  // deno-lint-ignore no-explicit-any
  const model = new (globalThis as any).Supabase.ai.Session('gte-small')
  await db.from('document_chunks').delete().eq('document_id', documentId)
  let idx = 0
  for (const content of chunks) {
    const embedding = await model.run(content, { mean_pool: true, normalize: true })
    await db.from('document_chunks').insert({ document_id: documentId, owner_id: ownerId, idx, content, embedding })
    idx++
  }
  return idx
}

// Ingest a block of raw text as a `note` document (no backing file): create the
// `documents` row, chunk + embed + store synchronously, mark it done, and log
// activity. Throws on failure after flipping the row to `error`. Defaults to
// workspace scope so the whole team's chat can search it.
export async function ingestText(
  db: DB,
  opts: { ownerId: string; name: string; text: string; scope?: 'workspace' | 'private' },
): Promise<{ documentId: string; chunkCount: number }> {
  const chunks = chunkText(opts.text)
  if (chunks.length === 0) throw new Error('nothing to index after cleaning the text')
  const scope = opts.scope === 'private' ? 'private' : 'workspace'

  const { data: doc, error } = await db
    .from('documents')
    .insert({ owner_id: opts.ownerId, name: opts.name, source: 'note', scope, status: 'processing' })
    .select('id')
    .single()
  if (error || !doc) throw new Error(error?.message ?? 'could not create the document')
  const documentId = doc.id as string

  try {
    const chunkCount = await embedAndStore(db, documentId, opts.ownerId, chunks)
    await db.from('documents').update({
      status: 'done',
      error: null,
      chunk_count: chunkCount,
      updated_at: new Date().toISOString(),
    }).eq('id', documentId)
    await db.from('activity_log').insert({
      type: 'document.indexed',
      summary: `Indexed note "${opts.name}" (${chunkCount} chunks)`,
      detail: { document_id: documentId, source: 'note', scope },
      actor_id: opts.ownerId,
    })
    return { documentId, chunkCount }
  } catch (err) {
    await db.from('documents').update({
      status: 'error',
      error: err instanceof Error ? err.message : 'indexing failed',
      updated_at: new Date().toISOString(),
    }).eq('id', documentId)
    throw err
  }
}
