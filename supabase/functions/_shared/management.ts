// Supabase Management API client — the ONLY module that touches the platform
// access token (SUPABASE_PAT). Forge uses it to deploy/delete edge functions
// programmatically from inside the app. Keep the PAT confined here: it is
// org-powerful, so nothing else should read it.
//
// Deploy contract (verified against the Management API):
//   POST https://api.supabase.com/v1/projects/{ref}/functions/deploy?slug={slug}[&bundleOnly=1]
//     Authorization: Bearer {SUPABASE_PAT}
//     Content-Type: multipart/form-data
//       part "metadata" = JSON { name, entrypoint_path: "index.ts", verify_jwt }
//       part "file"     = the index.ts source (one or more file parts allowed)
//   ?bundleOnly=true validates/bundles WITHOUT persisting — our dry-run gate.
//   DELETE https://api.supabase.com/v1/projects/{ref}/functions/{slug} tears it down.

const API_BASE = 'https://api.supabase.com/v1'

// NOTE: secret names must NOT start with `SUPABASE_` — that prefix is reserved by
// the platform for its own auto-injected secrets and cannot be set via
// `supabase secrets set`. So the PAT lives under FORGE_PAT.
function pat(): string | undefined {
  return Deno.env.get('FORGE_PAT') ?? undefined
}

function projectRef(): string | undefined {
  // Explicit ref preferred; otherwise derive from the auto-injected project URL
  // host (https://<ref>.supabase.co) — so usually no ref secret is needed.
  const explicit = Deno.env.get('FORGE_PROJECT_REF')
  if (explicit) return explicit
  const url = Deno.env.get('SUPABASE_URL') ?? ''
  const m = url.match(/^https?:\/\/([a-z0-9]+)\.supabase\./i)
  return m?.[1]
}

export function managementConfigured(): boolean {
  return Boolean(pat() && projectRef())
}

export interface DeployResult {
  ok: boolean
  status: number
  body: string
}

export interface DeployFile {
  name: string
  content: string
}

export interface DeployOptions {
  slug: string
  name: string
  source?: string
  // Multi-file deploy: pass the entrypoint + its relative deps. `entrypointPath`
  // must match one of the file names. When omitted, falls back to a single
  // `index.ts` built from `source` (the Forge path).
  files?: DeployFile[]
  entrypointPath?: string
  verifyJwt?: boolean
  bundleOnly?: boolean
}

// Deploy (or, with bundleOnly, just validate) an edge function — single-file via
// `source`, or multi-file via `files` + `entrypointPath`.
export async function deployFunction(opts: DeployOptions): Promise<DeployResult> {
  const ref = projectRef()
  const token = pat()
  if (!ref || !token) {
    return { ok: false, status: 0, body: 'Management API not configured (need SUPABASE_PAT + SUPABASE_PROJECT_REF).' }
  }

  const params = new URLSearchParams({ slug: opts.slug })
  // The Management API expects a boolean string ("true"/"false"), not "1".
  if (opts.bundleOnly) params.set('bundleOnly', 'true')

  const files: DeployFile[] =
    opts.files && opts.files.length ? opts.files : [{ name: 'index.ts', content: opts.source ?? '' }]
  const entrypoint = opts.entrypointPath ?? 'index.ts'

  const metadata = {
    name: opts.name || opts.slug,
    entrypoint_path: entrypoint,
    verify_jwt: opts.verifyJwt ?? false,
  }

  const form = new FormData()
  form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }))
  for (const f of files) {
    form.append('file', new Blob([f.content], { type: 'application/typescript' }), f.name)
  }

  try {
    const res = await fetch(`${API_BASE}/projects/${ref}/functions/deploy?${params}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    })
    const body = (await res.text().catch(() => '')).slice(0, 4000)
    return { ok: res.ok, status: res.status, body }
  } catch (err) {
    return { ok: false, status: 0, body: err instanceof Error ? err.message : 'deploy request failed' }
  }
}

// Remove a deployed function. Best-effort; returns ok=false with a message on error.
export async function deleteFunction(slug: string): Promise<DeployResult> {
  const ref = projectRef()
  const token = pat()
  if (!ref || !token) {
    return { ok: false, status: 0, body: 'Management API not configured.' }
  }
  try {
    const res = await fetch(`${API_BASE}/projects/${ref}/functions/${slug}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    })
    const body = (await res.text().catch(() => '')).slice(0, 2000)
    // A missing function (already gone) is fine for teardown.
    return { ok: res.ok || res.status === 404, status: res.status, body }
  } catch (err) {
    return { ok: false, status: 0, body: err instanceof Error ? err.message : 'delete request failed' }
  }
}
