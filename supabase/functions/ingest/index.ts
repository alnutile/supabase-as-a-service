// Supabase Edge Function: `ingest` (PUBLIC — verify_jwt=false, gated by the
// cron_config secret). Indexes uploaded PDFs into pgvector — RESUMABLY, so large
// decks don't die on the edge worker's compute limit:
//
//   1. PARSE phase (a `pending` doc): download + extract the text layer (unpdf),
//      chunk it, and insert every chunk row with embedding = NULL. No embeddings
//      run here — parsing a big PDF already uses most of one invocation's budget,
//      so we isolate it. The doc flips to `processing`.
//   2. EMBED phase (a `processing` doc): embed a small BATCH of the still-NULL
//      chunks with the in-edge gte-small model and fill them in. Repeats across
//      cron ticks until none remain, then the doc flips to `done`.
//
// Because chunks are filled one at a time, a run that dies mid-batch loses no
// progress — the next tick just picks up the remaining NULLs. Stale `processing`
// rows (a crashed run) are re-picked after STALE_SECONDS, fixing the old bug
// where a half-done doc stuck in `processing` was never retried. Partially
// indexed docs are safe to search: match_document_chunks ignores NULL embeddings.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4'
import { extractText, getDocumentProxy } from 'npm:unpdf@0.11.0'
import { chunkText } from '../_shared/knowledge.ts'

const DOCS_PER_RUN = 2 // documents touched per invocation
const EMBED_BATCH = 4 // chunks embedded per document per invocation (kept low so a
//                       single invocation stays well under the edge compute limit;
//                       large docs finish across several cron ticks)
const STALE_SECONDS = 15 // re-pick a `processing` doc this long after its last update

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return new Response('POST only', { status: 405 })
  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

  const secret = req.headers.get('x-cron-secret') ?? ''
  const { data: cfg } = await db.from('cron_config').select('secret').limit(1).maybeSingle()
  if (!cfg || secret !== cfg.secret) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 })

  const now = () => new Date().toISOString()
  const staleTs = new Date(Date.now() - STALE_SECONDS * 1000).toISOString()

  // Resume in-flight docs first, then start fresh ones.
  const { data: procDocs } = await db
    .from('documents')
    .select('id, owner_id, file_id, name, status')
    .eq('status', 'processing')
    .lt('updated_at', staleTs)
    .order('created_at', { ascending: true })
    .limit(DOCS_PER_RUN)
  const { data: pendingDocs } = await db
    .from('documents')
    .select('id, owner_id, file_id, name, status')
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(DOCS_PER_RUN)
  const docs = [...(procDocs ?? []), ...(pendingDocs ?? [])].slice(0, DOCS_PER_RUN)

  // deno-lint-ignore no-explicit-any
  const model = new (globalThis as any).Supabase.ai.Session('gte-small')
  let indexed = 0
  let embedded = 0

  const countChunks = async (docId: string, onlyNull = false) => {
    let q = db.from('document_chunks').select('id', { count: 'exact', head: true }).eq('document_id', docId)
    if (onlyNull) q = q.is('embedding', null)
    const { count } = await q
    return count ?? 0
  }
  const finish = async (doc: { id: string; name: string; owner_id: string }) => {
    const total = await countChunks(doc.id)
    await db.from('documents').update({ status: 'done', error: null, chunk_count: total, updated_at: now() }).eq('id', doc.id)
    await db.from('activity_log').insert({
      type: 'document.indexed',
      summary: `Indexed ${doc.name} (${total} chunks)`,
      detail: { document_id: doc.id },
      actor_id: doc.owner_id,
    })
    indexed++
  }

  for (const doc of docs) {
    try {
      if (doc.status === 'pending') {
        // --- PARSE phase: extract + chunk + insert NULL-embedding rows. ---
        await db.from('documents').update({ status: 'processing', error: null, updated_at: now() }).eq('id', doc.id)
        const { data: file } = await db.from('files').select('bucket, path').eq('id', doc.file_id).single()
        if (!file) throw new Error('file not found')
        const { data: blob, error: dlErr } = await db.storage.from(file.bucket).download(file.path)
        if (dlErr || !blob) throw new Error('could not download file')

        const buf = new Uint8Array(await blob.arrayBuffer())
        const pdf = await getDocumentProxy(buf)
        const { text } = await extractText(pdf, { mergePages: true })
        const full = Array.isArray(text) ? text.join('\n') : (text ?? '')

        if (full.trim().length < 50) {
          await db.from('documents').update({
            status: 'error',
            error: 'No text layer (likely a scanned PDF) — vision extraction coming in Stage 2.',
            updated_at: now(),
          }).eq('id', doc.id)
          continue
        }

        const chunks = chunkText(full)
        await db.from('document_chunks').delete().eq('document_id', doc.id)
        const rows = chunks.map((content, idx) => ({ document_id: doc.id, owner_id: doc.owner_id, idx, content, embedding: null }))
        for (let i = 0; i < rows.length; i += 50) {
          await db.from('document_chunks').insert(rows.slice(i, i + 50))
        }
        // Leave as `processing` with chunk_count = total; embedding happens on
        // the next tick (keeps parse and embedding in separate budgets).
        await db.from('documents').update({ status: 'processing', chunk_count: chunks.length, updated_at: now() }).eq('id', doc.id)
        continue
      }

      // --- EMBED phase: fill a batch of NULL-embedding chunks. ---
      const { data: todo } = await db
        .from('document_chunks')
        .select('id, content')
        .eq('document_id', doc.id)
        .is('embedding', null)
        .order('idx', { ascending: true })
        .limit(EMBED_BATCH)

      if (!todo || todo.length === 0) {
        // Nothing left to embed: done (or an empty doc → error).
        if ((await countChunks(doc.id)) === 0) {
          await db.from('documents').update({ status: 'error', error: 'no chunks produced', updated_at: now() }).eq('id', doc.id)
        } else {
          await finish(doc)
        }
        continue
      }

      for (const ch of todo as Array<{ id: string; content: string }>) {
        const embedding = await model.run(ch.content, { mean_pool: true, normalize: true })
        await db.from('document_chunks').update({ embedding }).eq('id', ch.id)
        embedded++
      }

      if ((await countChunks(doc.id, true)) === 0) await finish(doc)
      else await db.from('documents').update({ updated_at: now() }).eq('id', doc.id)
    } catch (err) {
      await db.from('documents').update({
        status: 'error',
        error: err instanceof Error ? err.message : 'indexing failed',
        updated_at: now(),
      }).eq('id', doc.id)
    }
  }

  return new Response(JSON.stringify({ indexed, embedded }), { headers: { 'Content-Type': 'application/json' } })
})
