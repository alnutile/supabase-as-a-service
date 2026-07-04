// Shared executor for `http` tools — the one place a custom tool's request is
// actually sent. All agent loops (chat, webhook, scheduler, loop, evals) call
// this instead of carrying their own copy. The generic `http_request` builtin
// (builtins.ts) reuses resolveVaultRefs with stricter rules.
//
// Secret references: a tool's config.url or header values may embed
// `{{vault:secret_name}}`. Each reference is resolved at call time through the
// service-role-only `read_vault_secret` RPC, so the plaintext lives only in
// Supabase Vault — never in the `tools` row (workspace-readable), never in the
// client, and never in the model's context. Only `workspace`-scoped secrets
// resolve here (the RPC is called with a null user): a tool runs on behalf of
// many users, so a private secret must not leak through it.
//
// Host binding: `vault_secrets.allowed_hosts` pins a secret to the host(s) it
// may be sent to ('api.example.com' exact, '*.example.com' suffix). When the
// list is non-empty, resolution fails for a request to any other host — so a
// prompt-injected URL can never carry a bound credential somewhere else. With
// `requireBinding` (the generic http_request builtin, where the MODEL chose
// the url), an unbound secret refuses to resolve at all; admin-authored tool
// configs (`requireBinding: false`) allow unbound secrets for back-compat.
// A reference that can't be resolved fails the call loudly rather than sending
// the literal placeholder to the endpoint.

// deno-lint-ignore no-explicit-any
type DB = any

export interface HttpToolRow {
  name?: string
  config: { url?: string; method?: string; headers?: Record<string, string> } | null
}

const VAULT_REF = /\{\{\s*vault:([^}]+?)\s*\}\}/g

function hostMatches(host: string, entries: string[]): boolean {
  const h = host.toLowerCase()
  return entries.some((e) => {
    const rule = (e ?? '').trim().toLowerCase()
    if (!rule) return false
    if (rule.startsWith('*.')) return h.endsWith(rule.slice(1))
    return h === rule
  })
}

export async function resolveVaultRefs(
  db: DB,
  value: string,
  opts: { host: string; requireBinding: boolean },
): Promise<string> {
  const names = [...value.matchAll(VAULT_REF)].map((m) => m[1].trim())
  if (!names.length) return value
  const resolved = new Map<string, string>()
  for (const name of names) {
    if (resolved.has(name.toLowerCase())) continue
    const { data: meta } = await db
      .from('vault_secrets')
      .select('allowed_hosts')
      .ilike('name', name)
      .maybeSingle()
    const hosts = ((meta?.allowed_hosts ?? []) as string[]).filter(Boolean)
    if (opts.requireBinding && !hosts.length) {
      throw new Error(
        `vault secret "${name}" has no allowed hosts — an admin must add this API's host to it in Secrets before it can be used with http_request`,
      )
    }
    if (hosts.length && !hostMatches(opts.host, hosts)) {
      throw new Error(`vault secret "${name}" is not allowed for host "${opts.host}"`)
    }
    const { data, error } = await db.rpc('read_vault_secret', { p_name: name, p_user_id: null })
    if (error || !data || typeof data !== 'string') {
      throw new Error(`vault secret "${name}" not found or not workspace-shared`)
    }
    resolved.set(name.toLowerCase(), data)
  }
  return value.replace(VAULT_REF, (_, n: string) => resolved.get(n.trim().toLowerCase()) ?? '')
}

export function hostOf(url: string): string {
  try {
    // Placeholders are legal in the query/path; neutralize them so URL parses.
    return new URL(url.replace(VAULT_REF, 'x')).hostname
  } catch {
    return ''
  }
}

export async function runHttpTool(db: DB, tool: HttpToolRow, input: unknown): Promise<string> {
  const rawUrl = tool.config?.url
  if (!rawUrl) return 'Tool is misconfigured: no url.'
  let url: string
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  try {
    const host = hostOf(rawUrl)
    url = await resolveVaultRefs(db, rawUrl, { host, requireBinding: false })
    for (const [k, v] of Object.entries(tool.config?.headers ?? {})) {
      headers[k] = await resolveVaultRefs(db, String(v), { host, requireBinding: false })
    }
  } catch (err) {
    return `Tool is misconfigured: ${err instanceof Error ? err.message : 'bad secret reference'}.`
  }
  try {
    const res = await fetch(url, {
      method: tool.config?.method ?? 'POST',
      headers,
      body: JSON.stringify(input ?? {}),
    })
    const text = await res.text()
    // Cap to keep tool results from blowing the context window.
    return text.slice(0, 50000) || `(empty response, status ${res.status})`
  } catch (err) {
    return `Tool call failed: ${err instanceof Error ? err.message : 'error'}`
  }
}
