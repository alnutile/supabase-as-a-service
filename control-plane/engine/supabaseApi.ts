// Supabase Management API client for the provisioner. Sibling of the app's
// supabase/functions/_shared/management.ts (Forge) — that one maintains a single
// known project; this one bootstraps NEW tenant projects, so it takes the PAT and
// ref explicitly instead of reading Deno env.
//
// Endpoint references (https://api.supabase.com/api/v1 docs):
//   POST   /v1/projects                          create project
//   GET    /v1/projects/{ref}                    status (ACTIVE_HEALTHY when up)
//   GET    /v1/projects/{ref}/api-keys           anon + service_role keys
//   POST   /v1/projects/{ref}/database/query     run SQL (used for migrations)
//   POST   /v1/projects/{ref}/secrets            set edge-function secrets
//   PATCH  /v1/projects/{ref}/config/auth        site_url + uri_allow_list
//   POST   /v1/projects/{ref}/functions/deploy   multipart, same contract as Forge
//   POST   /v1/projects/{ref}/pause | /restore   lifecycle
// The functions/deploy contract is copied verbatim from _shared/management.ts
// (verified there). Re-verify the others against current docs on first live run.

const API = 'https://api.supabase.com/v1'

export interface DeployFile {
  name: string
  content: string
}

// The Management API rate-limits (~60 req/min → 429 ThrottlerException).
// Every request retries 429s with backoff so callers never see transient
// throttling; real errors surface immediately.
async function req(pat: string, method: string, path: string, body?: unknown): Promise<Response> {
  const backoffs = [10_000, 20_000, 40_000, 60_000]
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${pat}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    if (res.status !== 429 || attempt >= backoffs.length) return res
    const retryAfter = Number(res.headers.get('retry-after'))
    const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : backoffs[attempt]
    await res.body?.cancel().catch(() => {})
    await new Promise((r) => setTimeout(r, wait))
  }
}

async function must(res: Response, what: string): Promise<any> {
  const text = await res.text().catch(() => '')
  if (!res.ok) throw new Error(`${what} failed (${res.status}): ${text.slice(0, 500)}`)
  try {
    return text ? JSON.parse(text) : {}
  } catch {
    return { raw: text }
  }
}

export async function createProject(opts: {
  pat: string
  organizationId: string
  name: string
  region: string
  dbPassword: string
}): Promise<{ ref: string }> {
  const res = await req(opts.pat, 'POST', '/projects', {
    organization_id: opts.organizationId,
    name: opts.name,
    region: opts.region,
    db_pass: opts.dbPassword,
  })
  const json = await must(res, 'create project')
  const ref = json.id ?? json.ref
  if (!ref) throw new Error(`create project: no ref in response ${JSON.stringify(json).slice(0, 300)}`)
  return { ref }
}

export async function projectStatus(pat: string, ref: string): Promise<string> {
  const json = await must(await req(pat, 'GET', `/projects/${ref}`), 'get project')
  return json.status ?? 'UNKNOWN'
}

export async function getApiKeys(
  pat: string,
  ref: string,
): Promise<{ anon: string; serviceRole: string }> {
  const json = await must(await req(pat, 'GET', `/projects/${ref}/api-keys`), 'get api keys')
  const keys: Array<{ name: string; api_key: string }> = Array.isArray(json) ? json : []
  const anon = keys.find((k) => k.name === 'anon')?.api_key
  const serviceRole = keys.find((k) => k.name === 'service_role')?.api_key
  if (!anon || !serviceRole) throw new Error('api keys response missing anon/service_role')
  return { anon, serviceRole }
}

// Transient infra errors surface as 400s whose body carries a socket-level
// message (seen live: "connect ECONNREFUSED …:5432" on a project that had just
// turned ACTIVE_HEALTHY). Those retry with backoff; real SQL errors fail fast.
const TRANSIENT_DB = /ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|Connection terminated|timeout expired/i

export async function runQuery(pat: string, ref: string, query: string): Promise<unknown> {
  const backoffs = [10_000, 20_000, 30_000, 60_000]
  for (let attempt = 0; ; attempt++) {
    try {
      return await must(await req(pat, 'POST', `/projects/${ref}/database/query`, { query }), 'database query')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (attempt >= backoffs.length || !TRANSIENT_DB.test(msg)) throw err
      await new Promise((r) => setTimeout(r, backoffs[attempt]))
    }
  }
}

export async function setSecrets(
  pat: string,
  ref: string,
  secrets: Record<string, string>,
): Promise<void> {
  const payload = Object.entries(secrets).map(([name, value]) => ({ name, value }))
  await must(await req(pat, 'POST', `/projects/${ref}/secrets`, payload), 'set secrets')
}

export async function configureAuth(
  pat: string,
  ref: string,
  opts: { siteUrl: string; redirectUrls: string[] },
): Promise<void> {
  await must(
    await req(pat, 'PATCH', `/projects/${ref}/config/auth`, {
      site_url: opts.siteUrl,
      uri_allow_list: opts.redirectUrls.join(','),
    }),
    'configure auth',
  )
}

// Same multipart contract as _shared/management.ts deployFunction (verified there).
export async function deployFunction(opts: {
  pat: string
  ref: string
  slug: string
  files: DeployFile[]
  entrypointPath: string
  verifyJwt: boolean
}): Promise<void> {
  const params = new URLSearchParams({ slug: opts.slug })
  const form = new FormData()
  form.append(
    'metadata',
    new Blob(
      [JSON.stringify({ name: opts.slug, entrypoint_path: opts.entrypointPath, verify_jwt: opts.verifyJwt })],
      { type: 'application/json' },
    ),
  )
  for (const f of opts.files) {
    form.append('file', new Blob([f.content], { type: 'application/typescript' }), f.name)
  }
  const res = await fetch(`${API}/projects/${opts.ref}/functions/deploy?${params}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${opts.pat}` },
    body: form,
  })
  await must(res, `deploy function ${opts.slug}`)
}

export async function pauseProject(pat: string, ref: string): Promise<void> {
  await must(await req(pat, 'POST', `/projects/${ref}/pause`), 'pause project')
}

/** Permanently delete a project (teardown). A 404 means already gone — success. */
export async function deleteProject(pat: string, ref: string): Promise<void> {
  const res = await req(pat, 'DELETE', `/projects/${ref}`)
  if (!res.ok && res.status !== 404) {
    const body = await res.text().catch(() => '')
    throw new Error(`delete project failed (${res.status}): ${body.slice(0, 300)}`)
  }
  await res.body?.cancel().catch(() => {})
}

export async function restoreProject(pat: string, ref: string): Promise<void> {
  await must(await req(pat, 'POST', `/projects/${ref}/restore`), 'restore project')
}
