// Cloudflare DNS client — per tenant: a CNAME (acme.supanet.io → the Railway
// DNS target) plus Railway's ownership-verification TXT record
// (_railway-verify.acme). Token needs Zone:DNS:Edit on the supanet.io zone only.

const CF = 'https://api.cloudflare.com/client/v4'

async function upsertRecord(opts: {
  token: string
  zoneId: string
  type: 'CNAME' | 'TXT'
  name: string
  content: string
  proxied?: boolean
}): Promise<void> {
  const headers = { Authorization: `Bearer ${opts.token}`, 'Content-Type': 'application/json' }
  const listRes = await fetch(
    `${CF}/zones/${opts.zoneId}/dns_records?type=${opts.type}&name=${encodeURIComponent(opts.name)}`,
    { headers },
  )
  const list = (await listRes.json().catch(() => ({}))) as any
  const existing = list?.result?.[0]?.id as string | undefined

  const body = JSON.stringify({
    type: opts.type,
    name: opts.name,
    content: opts.content,
    ...(opts.type === 'CNAME' ? { proxied: opts.proxied ?? false } : {}),
    ttl: 1, // auto
  })
  const res = existing
    ? await fetch(`${CF}/zones/${opts.zoneId}/dns_records/${existing}`, { method: 'PUT', headers, body })
    : await fetch(`${CF}/zones/${opts.zoneId}/dns_records`, { method: 'POST', headers, body })
  const json = (await res.json().catch(() => ({}))) as any
  if (!res.ok || json?.success === false) {
    throw new Error(`Cloudflare DNS upsert failed: ${JSON.stringify(json?.errors ?? json).slice(0, 400)}`)
  }
}

/** Railway ownership verification: TXT _railway-verify.‹slug› = railway-verify=… */
export async function upsertTxt(opts: {
  token: string
  zoneId: string
  name: string
  content: string
}): Promise<void> {
  await upsertRecord({ ...opts, type: 'TXT' })
}

export async function upsertCname(opts: {
  token: string
  zoneId: string
  /** Full record name, e.g. "acme.supanet.io" */
  name: string
  /** CNAME target, e.g. the Railway domain */
  target: string
  proxied?: boolean
}): Promise<void> {
  // Railway custom domains do their own TLS and must see their own CNAME
  // target, so records stay DNS-only (proxied=false) unless explicitly asked.
  await upsertRecord({
    token: opts.token,
    zoneId: opts.zoneId,
    type: 'CNAME',
    name: opts.name,
    content: opts.target,
    proxied: opts.proxied,
  })
}
