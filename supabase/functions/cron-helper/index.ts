// Supabase Edge Function: `cron-helper`
// Converts natural language schedule descriptions (e.g., "Friday 7am") to cron
// expressions. Used by the agent editor's schedule UI to help users write cron
// expressions without memorizing the syntax.

import { createClient } from 'npm:@supabase/supabase-js@2.45.4'
import { resolveModel } from '../_shared/models.ts'
import { orComplete, systemMsg, type ORMessage } from '../_shared/openrouter.ts'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const SYSTEM_PROMPT = `You are a cron expression generator. Convert natural language schedule descriptions into valid 5-field cron expressions.

Format: minute hour day-of-month month day-of-week
Rules:
- Use * for "every" or "any"
- Day of week: 0-6 (Sunday=0, Monday=1, etc.)
- Use L in day-of-month for last day of month
- Ranges: 1-5 (Monday to Friday)
- Lists: 1,3,5 (Monday, Wednesday, Friday)
- Steps: */15 (every 15 minutes)

Examples:
- "Friday 7am" → "0 7 * * 5"
- "Every weekday at 9am" → "0 9 * * 1-5"
- "15th of every month at 2pm" → "0 14 15 * *"
- "Last day of month at 5pm" → "0 17 L * *"
- "Every 30 minutes" → "*/30 * * * *"

Return ONLY the cron expression, nothing else. If you cannot parse the input, return "INVALID".`

function admin() {
  const url = Deno.env.get('SUPABASE_URL')
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  return url && key ? createClient(url, key) : null
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: CORS })
  }

  try {
    const db = admin()
    if (!db) {
      return new Response(JSON.stringify({ error: 'Server configuration error' }), {
        status: 500,
        headers: { ...CORS, 'Content-Type': 'application/json' },
      })
    }

    // Require authentication
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'Missing authorization' }), {
        status: 401,
        headers: { ...CORS, 'Content-Type': 'application/json' },
      })
    }

    const token = authHeader.replace('Bearer ', '')
    const { data: { user } } = await db.auth.getUser(token)
    if (!user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { ...CORS, 'Content-Type': 'application/json' },
      })
    }

    const { text } = await req.json()
    if (!text || typeof text !== 'string') {
      return new Response(JSON.stringify({ error: 'Missing or invalid text field' }), {
        status: 400,
        headers: { ...CORS, 'Content-Type': 'application/json' },
      })
    }

    // Use the utility model for fast, cheap completions
    const model = await resolveModel(db, 'utility')

    const messages: ORMessage[] = [
      systemMsg(SYSTEM_PROMPT),
      { role: 'user', content: text.trim() },
    ]

    const result = await orComplete({ model, messages, maxTokens: 100 })
    const cron = result.content.trim()

    // Basic validation: should be 5 fields and not the INVALID marker
    const fields = cron.split(/\s+/)
    if (cron === 'INVALID' || fields.length !== 5) {
      return new Response(JSON.stringify({ error: 'Could not parse the description into a valid cron expression' }), {
        status: 400,
        headers: { ...CORS, 'Content-Type': 'application/json' },
      })
    }

    return new Response(JSON.stringify({ cron }), {
      status: 200,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    })
  } catch (error) {
    console.error('cron-helper error:', error)
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : 'Internal server error' }),
      { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } }
    )
  }
})
