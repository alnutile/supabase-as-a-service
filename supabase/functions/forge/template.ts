// Forge code contract: how a forged function is shaped, generated, and screened.
//
// A forged function is the model's (or a human's) `handler(input)` code wrapped
// in a FIXED runtime harness we control. The harness — not the generated code —
// owns request handling: method check, the per-function token check, JSON I/O,
// and CORS. The generated portion is pure logic: `async function handler(input)`
// (+ any imports / helpers), returning a JSON-serializable value. This keeps the
// security-critical request handling out of the model's hands and lets us lint
// the generated portion for secret access without false positives on the harness.

// Functions the platform itself owns — a forged slug can never shadow these.
export const RESERVED_SLUGS = new Set([
  'chat', 'webhook', 'mcp', 'scheduler', 'ingest', 'email-inbound', 'email-test', 'forge',
])

export function validateSlug(slug: string): string | null {
  if (!/^[a-z][a-z0-9_-]{2,40}$/.test(slug)) {
    return 'Slug must be 3–41 chars, lowercase, start with a letter, and use only a–z, 0–9, _ or -.'
  }
  if (RESERVED_SLUGS.has(slug)) return `"${slug}" is a reserved function name.`
  return null
}

// Static deny-list run over the GENERATED portion only (never the harness).
// Forged functions are pure-compute by default: no secrets, no process spawning,
// no defining their own server. A hit fails the forge closed before any deploy.
const DENY: Array<{ re: RegExp; why: string }> = [
  { re: /Deno\.env\b/, why: 'reads environment secrets (Deno.env)' },
  { re: /SERVICE_ROLE|SUPABASE_SERVICE_ROLE_KEY/i, why: 'references the service-role key' },
  { re: /SUPABASE_PAT/i, why: 'references the platform access token' },
  { re: /OPENROUTER_API_KEY|ANTHROPIC_API_KEY/i, why: 'references an LLM provider key' },
  { re: /mcp_tokens/i, why: 'touches the mcp_tokens table' },
  { re: /Deno\.serve\b/, why: 'defines its own server (the harness already serves it)' },
  { re: /Deno\.(run|Command)\b/, why: 'spawns a subprocess' },
  { re: /Deno\.(write|read)(File|TextFile)\b/, why: 'accesses the filesystem' },
  { re: /child_process/, why: 'imports child_process' },
  { re: /\beval\s*\(/, why: 'uses eval()' },
]

export function lintSource(generated: string): string[] {
  const hits: string[] = []
  for (const { re, why } of DENY) if (re.test(generated)) hits.push(why)
  if (!/\bhandler\b/.test(generated) || !/(function\s+handler|handler\s*=)/.test(generated)) {
    hits.push('does not define a `handler(input)` function')
  }
  return hits
}

// Wrap generated `handler` code in the fixed runtime harness, baking in this
// function's invoke token (compared against the x-forge-token header). The token
// lives only in the deployed code + the forged_functions row (admin-read RLS).
export function buildModule(generated: string, invokeToken: string): string {
  return `// Forged edge function — generated via Forge. Deployed by supabase/functions/forge.
// The block below is the generated logic; the harness at the bottom is fixed.

${generated.trim()}

// --- Forge runtime harness (auto-generated — do not edit) ---
const __FORGE_TOKEN = ${JSON.stringify(invokeToken)}
const __CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type, x-forge-token',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: __CORS })
  if (req.method !== 'POST') return new Response('POST only', { status: 405, headers: __CORS })
  const tok = (req.headers.get('x-forge-token') ?? '').trim()
  if (!__FORGE_TOKEN || tok !== __FORGE_TOKEN) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: { ...__CORS, 'Content-Type': 'application/json' } })
  }
  let input = {}
  try { input = await req.json() } catch { input = {} }
  try {
    const output = await handler(input)
    return new Response(JSON.stringify(output ?? null), { headers: { ...__CORS, 'Content-Type': 'application/json' } })
  } catch (e) {
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }), { status: 400, headers: { ...__CORS, 'Content-Type': 'application/json' } })
  }
})
`
}

// System prompt for generating a forged function from a natural-language spec.
// The model returns STRICT JSON; we parse it, wrap the code, lint, and deploy.
export function generatorSystem(): string {
  return `You write a single Supabase Edge Function (Deno, TypeScript) that implements a capability described by an admin. It becomes a callable tool: an agent calls it with a JSON object, it returns a JSON object.

Write ONLY a pure logic module that defines:
  async function handler(input) { /* ... */ return output }
plus any imports (https URLs only, e.g. 'https://deno.land/std@.../...') and helper functions it needs. Do NOT write Deno.serve, request handling, CORS, or auth — a fixed harness wraps your handler and provides all of that. \`input\` is the parsed JSON request body (an object); return any JSON-serializable value.

HARD RULES (a violation is rejected, not deployed):
- No environment/secret access: do not use Deno.env or reference any API key, service-role key, or token.
- No filesystem, no subprocesses (Deno.run/Deno.Command), no eval, no child_process.
- No database access. Keep it pure-compute and/or fetch() to public/whitelisted HTTP APIs only.
- Deterministic and self-contained. Validate \`input\` and throw a clear Error on bad input.

Respond with STRICT JSON ONLY — no prose, no code fences — in exactly this shape:
{"slug":"snake_or_kebab_name","name":"Human Title","summary":"one line on what it does","input_schema":{"type":"object","properties":{...},"required":[...]},"code":"the TypeScript module defining handler(input)"}

The "code" value is the module source as a JSON string (escape newlines). The "input_schema" is the JSON Schema for the argument object the tool accepts.`
}
