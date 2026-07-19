// OpenRouter Provisioning API — mints one runtime API key per tenant with a spend
// limit. This is the "proxy": the limit caps burn, and the key's usage is our AI
// billing meter. Docs: https://openrouter.ai/docs/features/provisioning-api-keys
//
// The provisioning key itself (OPENROUTER_PROVISIONING_KEY) can only manage keys,
// not run inference; the minted runtime key is what goes into the tenant's
// edge-function secrets as OPENROUTER_API_KEY.

const OR = 'https://openrouter.ai/api/v1'

export async function mintTenantKey(opts: {
  provisioningKey: string
  /** Shown in the OpenRouter dashboard, e.g. "supanet-acme" */
  name: string
  /** Spend limit in USD for this key */
  limitUsd: number
}): Promise<{ key: string; hash: string }> {
  const res = await fetch(`${OR}/keys`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${opts.provisioningKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ name: opts.name, limit: opts.limitUsd }),
  })
  const json = (await res.json().catch(() => ({}))) as any
  if (!res.ok) throw new Error(`OpenRouter key mint failed (${res.status}): ${JSON.stringify(json).slice(0, 400)}`)
  const key = json?.key ?? json?.data?.key
  const hash = json?.data?.hash ?? json?.hash ?? ''
  if (!key) throw new Error(`OpenRouter key mint: no key in response ${JSON.stringify(json).slice(0, 300)}`)
  return { key, hash }
}

/** Usage for one tenant key (billing meter). */
export async function keyUsage(provisioningKey: string, hash: string): Promise<{ usageUsd: number; limitUsd: number | null }> {
  const res = await fetch(`${OR}/keys/${hash}`, {
    headers: { Authorization: `Bearer ${provisioningKey}` },
  })
  const json = (await res.json().catch(() => ({}))) as any
  if (!res.ok) throw new Error(`OpenRouter key read failed (${res.status})`)
  const d = json?.data ?? json
  return { usageUsd: Number(d?.usage ?? 0), limitUsd: d?.limit == null ? null : Number(d.limit) }
}

export async function disableKey(provisioningKey: string, hash: string): Promise<void> {
  const res = await fetch(`${OR}/keys/${hash}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${provisioningKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ disabled: true }),
  })
  if (!res.ok) throw new Error(`OpenRouter key disable failed (${res.status})`)
}
