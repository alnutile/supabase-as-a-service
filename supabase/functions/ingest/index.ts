// Supabase Edge Function: `ingest` (PUBLIC — verify_jwt=false, gated by the
// cron_config secret). Drains pending `documents`: extracts the PDF text layer
// (unpdf), chunks it, embeds each chunk for free with the in-edge gte-small
// model, and stores the chunks in pgvector. Text-layer PDFs only (Stage 1).
import { createClient } from 'npm:@supabase/supabase-js@2.45.4'
import { extractText, getDocumentProxy } from 'npm:unpdf@0.11.0'

const CHUNK_SIZE = 1500
const CHUNK_OVERLAP = 200
const MAX_CHUNKS = 200
const DOCS_PER_RUN = 3

function chunkText(text: string): string[] {
  const clean = text.replace(/\s+/g, ' ').trim()
  const out: string[] = []
  let i = 0
  while (i < clean.length && out.length < MAX_CHUNKS) {
    out.push(clean.slice(i, i + CHUNK_SIZE))
    i += CHUNK_SIZE - CHUNK_OVERLAP
  }
  return out.filter((c) => c.trim().length > 20)
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return new Response('POST only', { status: 405 })
  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

  const secret = req.headers.get('x-cron-secret') ?? ''
  const { data: cfg } = await db.from('cron_config').select('secret').limit(1).maybeSingle()
  if (!cfg || secret !== cfg.secret) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 })

  const { data: pending } = await db
    .from('documents')
    .select('id, owner_id, file_id, name')
    .eq('status', 'pending')
    .limit(DOCS_PER_RUN)

  // deno-lint-ignore no-explicit-any
  const model = new (globalThis as any).Supabase.ai.Session('gte-small')
  let indexed = 0

  for (const doc of pending ?? []) {
    await db.from('documents').update({ status: 'processing', updated_at: new Date().toISOString() }).eq('id', doc.id)
    try {
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
          updated_at: new Date().toISOString(),
        }).eq('id', doc.id)
        continue
      }

      const chunks = chunkText(full)
      await db.from('document_chunks').delete().eq('document_id', doc.id)

      let idx = 0
      for (const content of chunks) {
        const embedding = await model.run(content, { mean_pool: true, normalize: true })
        await db.from('document_chunks').insert({
          document_id: doc.id,
          owner_id: doc.owner_id,
          idx,
          content,
          embedding,
        })
        idx++
      }

      await db.from('documents').update({
        status: 'done',
        error: null,
        chunk_count: chunks.length,
        updated_at: new Date().toISOString(),
      }).eq('id', doc.id)

      await db.from('activity_log').insert({
        type: 'document.indexed',
        summary: `Indexed ${doc.name} (${chunks.length} chunks)`,
        detail: { document_id: doc.id },
        actor_id: doc.owner_id,
      })
      indexed++
    } catch (err) {
      await db.from('documents').update({
        status: 'error',
        error: err instanceof Error ? err.message : 'indexing failed',
        updated_at: new Date().toISOString(),
      }).eq('id', doc.id)
    }
  }

  return new Response(JSON.stringify({ indexed }), { headers: { 'Content-Type': 'application/json' } })
})
