// Supabase Edge Function: `p` (PUBLIC — verify_jwt=false).
// Serves a shared HTML artifact as a clean, standalone web page — no intranet
// chrome, no React, no iframe box. `GET /functions/v1/p/<slug>` looks up the
// artifact by `public_slug` and returns its raw `content` as text/html so a
// "great diagram in HTML" can be shared with the public directly, instead of
// deploying a whole app.
//
// PLATFORM CAVEAT: Supabase rewrites text/html responses to text/plain (+ a
// sandbox CSP) on *.supabase.co function URLs (anti-phishing), so browsers
// show raw source here unless the project has a Pro-plan custom functions
// domain. The in-app UI therefore links to the app's own /p/:slug route
// (StandaloneArtifactPage, sandboxed iframe) instead of this function.
//
// Security: we query with the ANON key, so Postgres RLS ("Read own or shared
// artifacts") only ever returns rows whose visibility is unlisted/public — the
// function never sees private artifacts. We serve user HTML on the functions
// origin where visitors hold no session, and send `nosniff` + a permissive CSP
// (diagrams legitimately pull CDN chart libs / inline scripts). Only `html`
// artifacts render here; everything else falls back to the in-app /share view.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4'
import { withMeta } from './meta.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
}

// Permissive enough for self-contained diagrams (inline + CDN scripts/styles,
// data/blob URIs) while keeping the page from being treated as anything but
// the document it is. The real isolation is that this origin holds no session.
const CSP =
  "default-src 'self' https: data: blob:; " +
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' https: blob:; " +
  "style-src 'self' 'unsafe-inline' https:; " +
  "img-src 'self' https: data: blob:; " +
  "font-src 'self' https: data:; " +
  "connect-src 'self' https:;"

function notFound() {
  return new Response(
    '<!doctype html><meta charset="utf-8"><title>Not found</title>' +
      '<body style="font:16px system-ui;padding:2rem;color:#334155">' +
      'This page isn’t available — it may be private or the link is incorrect.</body>',
    { status: 404, headers: { ...CORS, 'Content-Type': 'text/html; charset=utf-8' } },
  )
}

// escapeHtml/withMeta moved to ./meta.ts (unit-tested there).

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS })
  if (req.method !== 'GET') return notFound()

  const url = new URL(req.url)
  const parts = url.pathname.split('/').filter(Boolean)
  const i = parts.indexOf('p')
  const slug = i !== -1 ? parts[i + 1] : undefined
  if (!slug) return notFound()

  const db = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
  const { data } = await db
    .from('artifacts')
    .select('title, type, content, data')
    .eq('public_slug', slug)
    .maybeSingle()

  // RLS guarantees this is a non-private artifact. Only HTML renders standalone.
  if (!data || data.type !== 'html') return notFound()

  return new Response(withMeta(data.content ?? '', data.title ?? '', data.data), {
    status: 200,
    headers: {
      ...CORS,
      'Content-Type': 'text/html; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': CSP,
      'Cache-Control': 'public, max-age=60',
    },
  })
})
