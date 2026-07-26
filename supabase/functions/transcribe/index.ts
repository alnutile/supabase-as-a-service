// Supabase Edge Function: `transcribe`
// Transcribes audio to text using OpenAI Whisper API. Accepts audio in various
// formats (mp3, mp4, m4a, wav, webm) and returns the transcript. Used by the
// meeting notes recorder for real-time transcription.
//
// verify_jwt: true (authenticated users only)

import { createClient } from 'npm:@supabase/supabase-js@2.45.4'

const OPENAI_API_URL = 'https://api.openai.com/v1/audio/transcriptions'
const MAX_AUDIO_BYTES = 25_000_000 // 25MB (Whisper limit)

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
}

// The caller's user id, decoded from the already-verified JWT (verify_jwt:true,
// so the platform validated it before we ever run). Used to scope Vault reads.
function userIdFromAuth(req: Request): string | null {
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '')
  const parts = token.split('.')
  if (parts.length < 2) return null
  try {
    const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')))
    return typeof payload.sub === 'string' ? payload.sub : null
  } catch {
    return null
  }
}

// Resolve the OpenAI key. Admins store it in the in-app Secrets Vault (a
// `vault_secrets` row named OPENAI_KEY), read via the service-role-only
// `read_vault_secret` RPC — the same pattern as the email/MCP/github secrets.
// An edge-function env secret (OPENAI_KEY / OPENAI_API_KEY) is a fallback.
async function resolveOpenAiKey(req: Request): Promise<string | null> {
  const url = Deno.env.get('SUPABASE_URL')
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (url && serviceKey) {
    try {
      const db = createClient(url, serviceKey)
      const userId = userIdFromAuth(req)
      for (const name of ['OPENAI_KEY', 'OPENAI_API_KEY']) {
        const { data } = await db.rpc('read_vault_secret', { p_name: name, p_user_id: userId })
        if (typeof data === 'string' && data.trim()) return data.trim()
      }
    } catch {
      // Fall through to the env fallback below.
    }
  }
  return Deno.env.get('OPENAI_KEY') ?? Deno.env.get('OPENAI_API_KEY') ?? null
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS })

  try {
    // Transcription runs on OpenAI Whisper (OpenRouter has no audio endpoint).
    // The rest of the app defaults to OpenRouter, so this is the one place that
    // needs a dedicated OpenAI key — stored as a workspace secret named
    // OPENAI_KEY in the in-app Secrets Vault (env secret is a fallback).
    const apiKey = await resolveOpenAiKey(req)

    // Health check: a GET reports whether transcription is configured, so the
    // UI can show a "set OPENAI_KEY" notice up front instead of failing only
    // once someone hits Record. No audio work, never leaks the key itself.
    if (req.method === 'GET') {
      return new Response(
        JSON.stringify({ configured: !!apiKey }),
        { headers: { ...CORS, 'Content-Type': 'application/json' } },
      )
    }

    if (!apiKey) {
      return new Response(
        JSON.stringify({
          error: 'Transcription is not configured. Add a workspace secret named OPENAI_KEY in Settings → Secrets.',
        }),
        { status: 503, headers: { ...CORS, 'Content-Type': 'application/json' } },
      )
    }

    // Parse multipart form data
    const formData = await req.formData()
    const audioFile = formData.get('audio')
    const language = formData.get('language') as string | null

    if (!audioFile || !(audioFile instanceof File)) {
      return new Response(
        JSON.stringify({ error: 'No audio file provided' }),
        { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } },
      )
    }

    if (audioFile.size > MAX_AUDIO_BYTES) {
      return new Response(
        JSON.stringify({ error: 'Audio file too large (max 25MB)' }),
        { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } },
      )
    }

    // Forward to OpenAI Whisper API
    const whisperFormData = new FormData()
    whisperFormData.append('file', audioFile)
    whisperFormData.append('model', 'whisper-1')
    if (language) whisperFormData.append('language', language)

    // Request timestamp format for better structure
    whisperFormData.append('response_format', 'verbose_json')
    whisperFormData.append('timestamp_granularities[]', 'segment')

    const response = await fetch(OPENAI_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
      },
      body: whisperFormData,
    })

    if (!response.ok) {
      const error = await response.text()
      console.error('Whisper API error:', error)
      return new Response(
        JSON.stringify({ error: 'Transcription failed', details: error }),
        { status: response.status, headers: { ...CORS, 'Content-Type': 'application/json' } },
      )
    }

    const result = await response.json()

    // Return the transcript with timestamps if available
    return new Response(
      JSON.stringify({
        text: result.text,
        segments: result.segments || [],
        language: result.language || language,
        duration: result.duration,
      }),
      { headers: { ...CORS, 'Content-Type': 'application/json' } },
    )
  } catch (error) {
    console.error('Transcription error:', error)
    return new Response(
      JSON.stringify({ error: 'Internal server error', message: String(error) }),
      { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } },
    )
  }
})
