import { createClient } from '@supabase/supabase-js'
import type { Database } from './database.types'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string

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

/** Public ingest URL for a webhook (external systems POST here). */
export const webhookUrl = (token: string) => `${supabaseUrl}/functions/v1/webhook/${token}`

/** MCP server URL — connect an external Claude (Claude Code / Desktop) here. */
export const mcpUrl = `${supabaseUrl}/functions/v1/mcp`

/** Public inbound-email URL — point a provider's inbound webhook here. */
export const emailInboundUrl = (token: string) => `${supabaseUrl}/functions/v1/email-inbound/${token}`

/** URL of the deployed `forge` edge function (admin-only; generates + deploys functions). */
export const forgeFunctionUrl = `${supabaseUrl}/functions/v1/forge`

/** Standalone public page for a shared HTML artifact — raw HTML, no app chrome. */
export const standalonePageUrl = (slug: string) => `${supabaseUrl}/functions/v1/p/${slug}`

/** Base URL of the public Artifacts CRUD API (bearer-token auth via mcp_tokens). */
export const artifactsApiUrl = `${supabaseUrl}/functions/v1/artifacts`

/** Base URL of the public To-dos CRUD API (bearer-token auth via mcp_tokens). */
export const todosApiUrl = `${supabaseUrl}/functions/v1/todos`

/** URL of the `link-meta` edge function (fetches a URL's title/description/preview). */
export const linkMetaUrl = `${supabaseUrl}/functions/v1/link-meta`

/** Universal tool runner — invoke any active tool (or a chain) directly, no model. */
export const runToolUrl = `${supabaseUrl}/functions/v1/run-tool`

/** Slack Events API endpoint — paste into the Slack app's Event Subscriptions. */
export const slackEventsUrl = `${supabaseUrl}/functions/v1/slack-events`
