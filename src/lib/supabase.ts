import { createClient } from '@supabase/supabase-js'
import type { Database } from './database.types'

import { isLocalMode } from './mode'

// The local build has no Supabase. It still imports this module through pages
// that haven't moved to src/lib/data yet, so give it an inert placeholder
// client (those pages are behind the "not available locally yet" screen).
const supabaseUrl = isLocalMode ? 'http://127.0.0.1:9' : (import.meta.env.VITE_SUPABASE_URL as string)
const supabaseAnonKey = isLocalMode ? 'local-mode-no-supabase' : (import.meta.env.VITE_SUPABASE_ANON_KEY as string)

if (!supabaseUrl || !supabaseAnonKey) {
  // Surfaced early and loudly so misconfiguration is obvious in dev.
  // eslint-disable-next-line no-console
  console.error(
    'Missing Supabase env vars. Copy .env.example to .env.local and set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.',
  )
}

export const supabase = createClient<Database>(supabaseUrl, supabaseAnonKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
  realtime: {
    params: { eventsPerSecond: 10 },
  },
})

/** URL of the deployed `chat` edge function. */
export const chatFunctionUrl = `${supabaseUrl}/functions/v1/chat`

/** MCP server URL — connect an external Claude (Claude Code / Desktop) here. */
export const mcpUrl = `${supabaseUrl}/functions/v1/mcp`

/**
 * Standalone public page for a shared HTML artifact — full viewport, no app
 * chrome. Served by the app's own /p/:slug route (sandboxed iframe): Supabase
 * rewrites text/html to text/plain on *.supabase.co function URLs
 * (anti-phishing), so the `p` edge function only renders behind a custom
 * functions domain.
 */
export const standalonePageUrl = (slug: string) => `${window.location.origin}/p/${slug}`

/** URL of the `link-meta` edge function (fetches a URL's title/description/preview). */
export const linkMetaUrl = `${supabaseUrl}/functions/v1/link-meta`

/**
 * Public write-form endpoint. A form baked into a shared artifact/page POSTs
 * { token, values } here and one row lands in the owner's table (see the
 * `form-submit` edge function). The token is a secret-URL capability — safe to
 * embed in public HTML.
 */
export const formSubmitUrl = `${supabaseUrl}/functions/v1/form-submit`

/** Transcribe audio to text using OpenAI Whisper API. */
export const transcribeFunctionUrl = () => `${supabaseUrl}/functions/v1/transcribe`

/**
 * Stable, non-expiring public URL for a file published to the `public-files`
 * bucket (see migration 0106). Safe to bake into an artifact / static page.
 */
export const publicFileUrl = (publicPath: string) =>
  supabase.storage.from('public-files').getPublicUrl(publicPath).data.publicUrl
