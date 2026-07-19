// Cloudflare DNS client — one CNAME per tenant: acme.supanet.io → the Railway
// service's DNS target. Token needs Zone:DNS:Edit on the supanet.io zone only.

const CF = 'https://api.cloudflare.com/client/v4'

export async function upsertCname(opts: {
  token: string
  zoneId: string
  /** Full record name, e.g. "acme.supanet.io" */
  name: string
  /** CNAME target, e.g. the Railway domain */
  target: string
  proxied?: boolean
}): Promise<void> {
  const headers = { Authorization: `Bearer ${opts.token}`, 'Content-Type': 'application/json' }

  // Find an existing record (idempotent re-run) …
  const listRes = await fetch(
    `${CF}/zones/${opts.zoneId}/dns_records?type=CNAME&name=${encodeURIComponent(opts.name)}`,
    { headers },
  )
  const list = (await listRes.json().catch(() => ({}))) as any
  const existing = list?.result?.[0]?.id as string | undefined

  const body = JSON.stringify({
    type: 'CNAME',
    name: opts.name,
    content: opts.target,
    // Railway custom domains do their own TLS; DNS-only unless we decide to proxy.
    proxied: opts.proxied ?? false,
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
