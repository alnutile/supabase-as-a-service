// Supabase Edge Function: `transcribe`
// Transcribes audio to text using OpenAI Whisper API. Accepts audio in various
// formats (mp3, mp4, m4a, wav, webm) and returns the transcript. Used by the
// meeting notes recorder for real-time transcription.
//
// verify_jwt: true (authenticated users only)

const OPENAI_API_URL = 'https://api.openai.com/v1/audio/transcriptions'
const MAX_AUDIO_BYTES = 25_000_000 // 25MB (Whisper limit)

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS })

  try {
    // Transcription runs on OpenAI Whisper (OpenRouter has no audio endpoint).
    // The rest of the app defaults to OpenRouter, so this is the one place that
    // needs a dedicated OpenAI key — set it as the `OPENAI_KEY` edge secret.
    // (`OPENAI_API_KEY` is accepted as a fallback for older setups.)
    const apiKey = Deno.env.get('OPENAI_KEY') ?? Deno.env.get('OPENAI_API_KEY')
    if (!apiKey) {
      return new Response(
        JSON.stringify({
          error: 'Transcription is not configured. Ask an admin to set the OPENAI_KEY edge-function secret.',
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
