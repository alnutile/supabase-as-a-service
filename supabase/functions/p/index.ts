// Supabase Edge Function: `p` (PUBLIC — verify_jwt=false).
// Serves a shared HTML artifact as a clean, standalone web page — no intranet
// chrome, no React, no iframe box. `GET /functions/v1/p/<slug>` looks up the
// artifact by `public_slug` and returns its raw `content` as text/html so a
// "great diagram in HTML" can be shared with the public directly, instead of
// deploying a whole app.
//
// Security: we query with the ANON key, so Postgres RLS ("Read own or shared
// artifacts") only ever returns rows whose visibility is unlisted/public — the
// function never sees private artifacts. We serve user HTML on the functions
// origin where visitors hold no session, and send `nosniff` + a permissive CSP
// (diagrams legitimately pull CDN chart libs / inline scripts). Only `html`
// artifacts render here; everything else falls back to the in-app /share view.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4'

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

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// Inject <title> + OpenGraph tags so the public link unfurls nicely. If the
// HTML already has a <head>, splice the meta in; otherwise wrap a minimal doc.
function withMeta(html: string, title: string): string {
  const t = escapeHtml(title || 'Shared page')
  const hasTitle = /<title[\s>]/i.test(html)
  const meta =
    (hasTitle ? '' : `<title>${t}</title>`) +
    `<meta property="og:title" content="${t}">` +
    `<meta property="og:type" content="website">` +
    `<meta name="twitter:card" content="summary_large_image">`

  if (/<head[\s>]/i.test(html)) {
    return html.replace(/<head([^>]*)>/i, `<head$1>${meta}`)
  }
  if (/<html[\s>]/i.test(html)) {
    return html.replace(/<html([^>]*)>/i, `<html$1><head>${meta}</head>`)
  }
  return `<!doctype html><html><head><meta charset="utf-8">${meta}</head><body>${html}</body></html>`
}

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
    .select('title, type, content')
    .eq('public_slug', slug)
    .maybeSingle()

  // RLS guarantees this is a non-private artifact. Only HTML renders standalone.
  if (!data || data.type !== 'html') return notFound()

  return new Response(withMeta(data.content ?? '', data.title ?? ''), {
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
