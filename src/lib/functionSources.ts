// Build-time bundle of the repo's edge-function source, so the in-app
// "Update core functions" button can redeploy them via the Management API
// (forge `deploy_core` action). Edge functions don't ride the frontend
// auto-deploy, so this closes that gap from inside the app.
//
// `import.meta.glob(..., { query: '?raw', eager: true })` inlines each file's
// text at build time. Because the frontend auto-deploys from `main`, this source
// is always current as of the last frontend deploy. This module is heavy (it
// carries all function source), so it is **dynamically imported** (see
// lib/forge.ts `deployCore`) and never lands in the main bundle.

const raw = import.meta.glob('../../supabase/functions/**/*.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

// verify_jwt per function — mirrors supabase/config.toml. Anything not listed
// defaults to true (the platform default). Getting this wrong would expose a
// public endpoint or lock out a public one, so keep it in sync with config.toml.
const VERIFY_JWT: Record<string, boolean> = {
  webhook: false,
  mcp: false,
  'email-inbound': false,
  scheduler: false,
  ingest: false,
  p: false,
  chat: true,
  forge: true,
  loop: true,
  'email-test': true,
  'mcp-admin': true,
  evals: true,
  'openrouter-balance': true,
}

export interface CoreFile {
  name: string
  content: string
}
export interface CoreFunction {
  slug: string
  entrypoint_path: string
  verify_jwt: boolean
  files: CoreFile[]
}

// Group the globbed files into deployable functions: each function gets its own
// dir's files plus all of `_shared` (the bundler only pulls what the entrypoint
// imports, so over-including _shared is harmless and keeps this dependency-free).
export function loadCoreFunctions(): CoreFunction[] {
  const entries = Object.entries(raw).map(([key, content]) => {
    // Normalize "/abs/.../supabase/functions/chat/index.ts" → "functions/chat/index.ts".
    const marker = 'supabase/functions/'
    const idx = key.indexOf(marker)
    const path = idx >= 0 ? `functions/${key.slice(idx + marker.length)}` : key
    return { path, content }
  })

  const shared = entries.filter((e) => e.path.startsWith('functions/_shared/'))
  const slugs = new Set<string>()
  for (const e of entries) {
    const m = e.path.match(/^functions\/([^/]+)\//)
    if (m && m[1] !== '_shared') slugs.add(m[1])
  }

  const out: CoreFunction[] = []
  for (const slug of slugs) {
    const own = entries.filter((e) => e.path.startsWith(`functions/${slug}/`))
    // Only deploy functions with an index.ts entrypoint.
    if (!own.some((e) => e.path === `functions/${slug}/index.ts`)) continue
    out.push({
      slug,
      entrypoint_path: `functions/${slug}/index.ts`,
      verify_jwt: VERIFY_JWT[slug] ?? true,
      files: [...own, ...shared].map((e) => ({ name: e.path, content: e.content })),
    })
  }
  return out.sort((a, b) => a.slug.localeCompare(b.slug))
}
