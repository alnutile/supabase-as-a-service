// Supabase Edge Function: `form-submit` (PUBLIC — verify_jwt=false). The public
// WRITE endpoint for a user table: an anonymous visitor submits a form baked
// into a shared artifact/page and one row lands in the owner's table.
//
// Why this is safe (the ut_* tables never grant `anon`):
//   * The browser NEVER touches the anon key or the table. It POSTs
//     { token, values } here; this function runs as the SERVICE ROLE and does
//     all the work, enforcing every rule in code:
//       - resolve the opaque form token -> (table, owner, allow-list)  [capability]
//       - re-verify the form's owner can still WRITE that table         [no escalation]
//       - drop everything not on the column allow-list                  [insert-only, scoped]
//       - force owner_id to the form's owner                            [no spoofing]
//       - validate required fields + coerce types                       [buildSubmissionRow]
//       - cap submissions per rolling hour                              [abuse control]
//   * The token is a secret-URL capability (same trust model as webhooks.token),
//     safe to embed in public HTML.
//
// Reads are intentionally NOT supported here — a public read would expose other
// rows. That's a separate, curated surface for later.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4'
import { buildSubmissionRow, type FormFieldSpec, type TableColumn } from '../_shared/forms.ts'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })
}

const DOCS = `form-submit — submit one row into a user table via a public form token.

POST /functions/v1/form-submit
Body (JSON):
  {
    "token": "<the form's token>",   (required)
    "values": { "email": "j@x.com", "name": "Jane" }
  }
-> { "ok": true, "id": "<new row id>" }

Only the columns the form owner allow-listed are written; everything else is
ignored. Required fields and types are validated. Reads are not supported here.
`

interface FormRow {
  id: string
  table_id: string
  owner_id: string
  fields: FormFieldSpec[]
  active: boolean
  max_per_hour: number
}
interface TableRow {
  id: string
  physical_name: string
  owner_id: string
  visibility: string
  columns: TableColumn[]
}

// deno-lint-ignore no-explicit-any
type DB = any

async function ownerCanWriteTable(db: DB, t: TableRow, ownerId: string): Promise<boolean> {
  if (t.owner_id === ownerId) return true
  if (t.visibility === 'workspace') return true
  const { data } = await db.from('profiles').select('is_admin').eq('id', ownerId).maybeSingle()
  return !!data?.is_admin
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method === 'GET') {
    return new Response(DOCS, { headers: { ...CORS, 'Content-Type': 'text/plain; charset=utf-8' } })
  }
  if (req.method !== 'POST') return json({ error: 'Use POST' }, 405)

  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!supabaseUrl || !serviceKey) return json({ error: 'Server not configured' }, 500)
  const db = createClient(supabaseUrl, serviceKey)

  let payload: Record<string, unknown>
  try {
    payload = (await req.json()) as Record<string, unknown>
  } catch {
    return json({ error: 'invalid JSON' }, 400)
  }

  const token = typeof payload.token === 'string' ? payload.token.trim() : ''
  if (!token) return json({ error: 'A form "token" is required.' }, 400)
  const values = (payload.values && typeof payload.values === 'object'
    ? payload.values
    : {}) as Record<string, unknown>

  // Resolve the form by its opaque token (service role — no RLS on this path).
  const { data: form } = await db
    .from('table_forms')
    .select('id, table_id, owner_id, fields, active, max_per_hour')
    .eq('token', token)
    .maybeSingle()
  if (!form || !(form as FormRow).active) {
    // Don't distinguish "wrong token" from "inactive" — both are just "no form".
    return json({ error: 'This form is not available.' }, 404)
  }
  const f = form as FormRow

  const { data: table } = await db
    .from('user_tables')
    .select('id, physical_name, owner_id, visibility, columns')
    .eq('id', f.table_id)
    .maybeSingle()
  if (!table) return json({ error: 'This form is not available.' }, 404)
  const t = table as TableRow

  // Re-verify the form owner can still write this table (visibility may have
  // changed since the form was created). Belt to the RLS `with check`'s braces.
  if (!(await ownerCanWriteTable(db, t, f.owner_id))) {
    return json({ error: 'This form is not available.' }, 404)
  }

  // Abuse control: cap submissions per rolling hour for THIS form.
  const cap = Number.isFinite(f.max_per_hour) && f.max_per_hour > 0 ? f.max_per_hour : 60
  const since = new Date(Date.now() - 3_600_000).toISOString()
  const { count } = await db
    .from('activity_log')
    .select('id', { count: 'exact', head: true })
    .eq('type', 'form.submission')
    .eq('detail->>form_id', f.id)
    .gte('created_at', since)
  if ((count ?? 0) >= cap) {
    return json({ error: 'This form is receiving too many submissions right now. Try again later.' }, 429)
  }

  // Filter to the allow-list, coerce, and validate required fields.
  const fields = Array.isArray(f.fields) ? f.fields : []
  const columns = Array.isArray(t.columns) ? t.columns : []
  const { row, errors } = buildSubmissionRow(columns, fields, values)
  if (errors.length) return json({ error: errors.join('; '), fields: errors }, 400)

  // Insert-only. owner_id is forced to the form's owner so the row shows up
  // under the table's RLS view for its owner/workspace.
  const { data: inserted, error } = await db
    .from(t.physical_name)
    .insert({ ...row, owner_id: f.owner_id })
    .select('id')
    .single()
  if (error) return json({ error: 'Could not save your submission.' }, 500)

  // Audit + rate-limit source. Actor is the form owner (the identity it runs as).
  await db.from('activity_log').insert({
    type: 'form.submission',
    summary: `Form submission received`,
    detail: { form_id: f.id, table_id: t.id, row_id: (inserted as { id: string }).id },
    actor_id: f.owner_id,
  }).then(() => {}, () => {})

  // Best-effort submission counter (a friendly total for the owner's UI).
  await db.rpc('increment_form_submission_count', { p_form_id: f.id }).then(() => {}, () => {})

  return json({ ok: true, id: (inserted as { id: string }).id })
})
