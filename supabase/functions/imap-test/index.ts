// Supabase Edge Function: `imap-test` (verify_jwt=true — a signed-in user only).
// "Test connection" for the Add-an-inbox form: opens IMAP, logs in, and SELECTs
// the folder, returning the mailbox message count — so you can validate an app
// password before saving / before the first poll. Reuses the same _shared IMAP
// client as `email-poll`, so a green test proves the real poll path.
//
// Credentials come either directly from the form body (adding / changing a
// password) or, for a saved inbox whose password field was left blank, are read
// from Vault by account id after re-checking the caller may access that account.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4'
import { ImapClient, withTimeout } from '../_shared/imap_client.ts'

const SOCKET_TIMEOUT_MS = 20_000

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return json({ ok: false, error: 'POST only' }, 405)

  const url = Deno.env.get('SUPABASE_URL')!
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!

  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return json({ ok: false, error: 'invalid JSON' }, 400)
  }

  let host = String(body.host ?? '').trim()
  let port = Number(body.port) || 993
  let secure = body.secure === undefined ? true : Boolean(body.secure)
  let username = String(body.username ?? '').trim()
  let folder = String(body.folder ?? 'INBOX').trim() || 'INBOX'
  let password = String(body.password ?? '')
  const accountId = body.account_id ? String(body.account_id) : ''

  // Saved inbox with no new password typed: fetch the stored one from Vault after
  // confirming the caller may access the account.
  if (!password && accountId) {
    const authHeader = req.headers.get('Authorization') ?? ''
    const userClient = createClient(url, anonKey, { global: { headers: { Authorization: authHeader } } })
    const { data: auth } = await userClient.auth.getUser()
    const uid = auth?.user?.id
    if (!uid) return json({ ok: false, error: 'not authenticated' }, 401)

    const svc = createClient(url, serviceKey)
    const { data: acct } = await svc
      .from('email_accounts')
      .select('host, port, secure, username, folder, owner_id, visibility')
      .eq('id', accountId)
      .maybeSingle()
    if (!acct) return json({ ok: false, error: 'inbox not found' }, 404)
    const { data: prof } = await svc.from('profiles').select('is_admin').eq('id', uid).maybeSingle()
    const mayAccess = acct.owner_id === uid || acct.visibility === 'workspace' || Boolean(prof?.is_admin)
    if (!mayAccess) return json({ ok: false, error: 'not allowed' }, 403)

    const { data: secret } = await svc.rpc('read_email_account_secret', { p_account_id: accountId })
    if (!secret) return json({ ok: false, error: 'stored password not found' }, 400)
    password = String(secret)
    host = host || acct.host
    port = port || acct.port
    secure = body.secure === undefined ? acct.secure : secure
    username = username || acct.username
    folder = folder || acct.folder || 'INBOX'
  }

  if (!host || !username || !password) {
    return json({ ok: false, error: 'host, username and password are required' }, 400)
  }

  let client: ImapClient | null = null
  try {
    client = await withTimeout(ImapClient.connect(host, port, secure), SOCKET_TIMEOUT_MS, 'connect')
    await withTimeout(client.login(username, password), SOCKET_TIMEOUT_MS, 'login')
    const info = await withTimeout(client.selectInfo(folder), SOCKET_TIMEOUT_MS, 'select')
    await client.logout()
    return json({ ok: true, exists: info.exists, message: `Connected — ${folder} has ${info.exists} message(s).` })
  } catch (e) {
    return json({ ok: false, error: e instanceof Error ? e.message : 'connection failed' })
  } finally {
    client?.close()
  }
})
