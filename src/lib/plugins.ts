// Plugin catalog — a curated, hand-maintained index of Supabase Edge Function
// examples that pair well with this intranet. Each entry points at the upstream
// example folder so an admin can read the source and decide to set it up.
//
// This is intentionally a static list checked into the repo (not a live GitHub
// fetch): it stays readable offline, survives GitHub rate limits, and lets us
// add our own descriptions/categories. When upstream adds an example, add a row
// here. Source of truth for the folders:
// https://github.com/supabase/supabase/tree/master/examples/edge-functions/supabase/functions

export const PLUGINS_REPO_URL =
  'https://github.com/supabase/supabase/tree/master/examples/edge-functions/supabase/functions'

export type PluginCategory =
  | 'AI & ML'
  | 'Email'
  | 'Storage & Files'
  | 'Bots & Messaging'
  | 'Payments'
  | 'Database'
  | 'Web & Scraping'
  | 'Auth & Security'
  | 'Rate limiting & Cache'
  | 'Monitoring'
  | 'Infra & Misc'

export type Plugin = {
  /** Upstream folder name — also the slug we link to. */
  slug: string
  /** Human-friendly title. */
  name: string
  /** One-line description of what the example does. */
  description: string
  category: PluginCategory
  /** External services / secrets needed to run it, if any. */
  requires?: string[]
}

/** Full URL to an example's folder in the Supabase repo. */
export function pluginUrl(slug: string): string {
  return `${PLUGINS_REPO_URL}/${slug}`
}

export const PLUGIN_CATEGORIES: PluginCategory[] = [
  'AI & ML',
  'Email',
  'Storage & Files',
  'Bots & Messaging',
  'Payments',
  'Database',
  'Web & Scraping',
  'Auth & Security',
  'Rate limiting & Cache',
  'Monitoring',
  'Infra & Misc',
]

export const PLUGINS: Plugin[] = [
  // AI & ML
  {
    slug: 'openai',
    name: 'OpenAI completion',
    description: 'Call the OpenAI API from an edge function and stream a completion back.',
    category: 'AI & ML',
    requires: ['OpenAI API key'],
  },
  {
    slug: 'openai-image-generation',
    name: 'OpenAI image generation',
    description: 'Generate images with OpenAI (DALL·E) and return the result.',
    category: 'AI & ML',
    requires: ['OpenAI API key'],
  },
  {
    slug: 'huggingface-image-captioning',
    name: 'Hugging Face image captioning',
    description: 'Caption an uploaded image using a Hugging Face inference model.',
    category: 'AI & ML',
    requires: ['Hugging Face token'],
  },
  {
    slug: 'elevenlabs-text-to-speech',
    name: 'ElevenLabs text-to-speech',
    description: 'Turn text into natural speech audio via the ElevenLabs API.',
    category: 'AI & ML',
    requires: ['ElevenLabs API key'],
  },
  {
    slug: 'elevenlabs-speech-to-text',
    name: 'ElevenLabs speech-to-text',
    description: 'Transcribe an audio file to text via the ElevenLabs API.',
    category: 'AI & ML',
    requires: ['ElevenLabs API key'],
  },
  {
    slug: 'mcp/simple-mcp-server',
    name: 'Simple MCP server',
    description: 'A minimal Model Context Protocol server running on the edge.',
    category: 'AI & ML',
  },

  // Email
  {
    slug: 'send-email-resend',
    name: 'Send email (Resend)',
    description: 'Send transactional email through the Resend HTTP API.',
    category: 'Email',
    requires: ['Resend API key'],
  },
  {
    slug: 'send-email-smtp',
    name: 'Send email (SMTP)',
    description: 'Send email directly over SMTP from an edge function.',
    category: 'Email',
    requires: ['SMTP credentials'],
  },
  {
    slug: 'auth-hook-react-email-resend',
    name: 'Auth emails (React Email + Resend)',
    description: 'A Supabase Auth hook that renders React Email templates and sends them via Resend.',
    category: 'Email',
    requires: ['Resend API key'],
  },

  // Storage & Files
  {
    slug: 'file-upload-storage',
    name: 'File upload to Storage',
    description: 'Accept a multipart upload and store the file in a Storage bucket.',
    category: 'Storage & Files',
  },
  {
    slug: 'background-upload-storage',
    name: 'Background upload to Storage',
    description: 'Stream large uploads to Storage in the background after responding.',
    category: 'Storage & Files',
  },
  {
    slug: 'read-storage',
    name: 'Read from Storage',
    description: 'Serve a file out of a Storage bucket through an edge function.',
    category: 'Storage & Files',
  },
  {
    slug: 'image-manipulation',
    name: 'Image manipulation',
    description: 'Resize/transform images on the fly with a WASM image library.',
    category: 'Storage & Files',
  },
  {
    slug: 'og-image-with-storage-cdn',
    name: 'OG image with Storage CDN',
    description: 'Generate social/OG images and cache them on the Storage CDN.',
    category: 'Storage & Files',
  },

  // Bots & Messaging
  {
    slug: 'discord-bot',
    name: 'Discord bot',
    description: 'Handle Discord slash-command interactions from an edge function.',
    category: 'Bots & Messaging',
    requires: ['Discord app credentials'],
  },
  {
    slug: 'slack-bot-mention',
    name: 'Slack mention bot',
    description: 'Respond when your bot is @mentioned in Slack via the Events API.',
    category: 'Bots & Messaging',
    requires: ['Slack app credentials'],
  },
  {
    slug: 'telegram-bot',
    name: 'Telegram bot',
    description: 'Receive Telegram updates over a webhook and reply.',
    category: 'Bots & Messaging',
    requires: ['Telegram bot token'],
  },

  // Payments
  {
    slug: 'stripe-webhooks',
    name: 'Stripe webhooks',
    description: 'Verify and process Stripe webhook events (with signature checking).',
    category: 'Payments',
    requires: ['Stripe API + webhook signing keys'],
  },

  // Database
  {
    slug: 'drizzle',
    name: 'Drizzle ORM',
    description: 'Query Postgres from the edge using the Drizzle ORM.',
    category: 'Database',
  },
  {
    slug: 'kysely-postgres',
    name: 'Kysely + Postgres',
    description: 'Type-safe SQL against Postgres using the Kysely query builder.',
    category: 'Database',
  },
  {
    slug: 'postgres-on-the-edge',
    name: 'Postgres on the edge',
    description: 'Connect directly to Postgres from an edge function with a pooled client.',
    category: 'Database',
  },
  {
    slug: 'select-from-table-with-auth-rls',
    name: 'Select with Auth + RLS',
    description: 'Query a table as the calling user so row-level security applies.',
    category: 'Database',
  },
  {
    slug: 'restful-tasks',
    name: 'RESTful tasks API',
    description: 'A small CRUD REST API backed by a Postgres table.',
    category: 'Database',
  },

  // Web & Scraping
  {
    slug: 'puppeteer',
    name: 'Puppeteer (headless browser)',
    description: 'Drive a headless browser for screenshots or scraping.',
    category: 'Web & Scraping',
  },
  {
    slug: 'browser-with-cors',
    name: 'Browser fetch with CORS',
    description: 'A function template that handles CORS preflight for browser callers.',
    category: 'Web & Scraping',
  },
  {
    slug: 'opengraph',
    name: 'OpenGraph metadata',
    description: 'Fetch a URL and extract its OpenGraph metadata.',
    category: 'Web & Scraping',
  },
  {
    slug: 'tweet-to-image',
    name: 'Tweet to image',
    description: 'Render a tweet as a shareable image.',
    category: 'Web & Scraping',
  },

  // Auth & Security
  {
    slug: 'custom-jwt-validation',
    name: 'Custom JWT validation',
    description: 'Validate a custom JWT before running protected logic.',
    category: 'Auth & Security',
  },
  {
    slug: 'cloudflare-turnstile',
    name: 'Cloudflare Turnstile',
    description: 'Verify a Cloudflare Turnstile CAPTCHA token server-side.',
    category: 'Auth & Security',
    requires: ['Turnstile secret key'],
  },

  // Rate limiting & Cache
  {
    slug: 'upstash-redis-counter',
    name: 'Upstash Redis counter',
    description: 'A simple counter backed by Upstash Redis over HTTP.',
    category: 'Rate limiting & Cache',
    requires: ['Upstash Redis credentials'],
  },
  {
    slug: 'upstash-redis-ratelimit',
    name: 'Upstash Redis rate limit',
    description: 'Rate-limit requests using Upstash Redis.',
    category: 'Rate limiting & Cache',
    requires: ['Upstash Redis credentials'],
  },

  // Monitoring
  {
    slug: 'sentry',
    name: 'Sentry error tracking',
    description: 'Report edge-function errors to Sentry.',
    category: 'Monitoring',
    requires: ['Sentry DSN'],
  },
  {
    slug: 'sentryfied',
    name: 'Sentry (instrumented)',
    description: 'A fully Sentry-instrumented edge function example.',
    category: 'Monitoring',
    requires: ['Sentry DSN'],
  },

  // Infra & Misc
  {
    slug: 'oak-server',
    name: 'Oak HTTP server',
    description: 'Build routes with the Oak web framework inside an edge function.',
    category: 'Infra & Misc',
  },
  {
    slug: 'streams',
    name: 'Streaming response',
    description: 'Stream a response body incrementally to the client.',
    category: 'Infra & Misc',
  },
  {
    slug: 'wasm-modules',
    name: 'WASM modules',
    description: 'Load and run a WebAssembly module from an edge function.',
    category: 'Infra & Misc',
  },
  {
    slug: 'location',
    name: 'Request geolocation',
    description: 'Read the caller’s region/location from request headers.',
    category: 'Infra & Misc',
  },
  {
    slug: 'connect-supabase',
    name: 'Connect to Supabase',
    description: 'The starter pattern for a client connected to your Supabase project.',
    category: 'Infra & Misc',
  },
  {
    slug: 'github-action-deploy',
    name: 'Deploy via GitHub Action',
    description: 'CI workflow that deploys edge functions on push.',
    category: 'Infra & Misc',
  },
]
