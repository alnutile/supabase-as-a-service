// Shared bearer-token auth for the token-gated REST functions (artifacts, todos,
// run-tool). These functions are deployed `verify_jwt = false` and gate access
// in code instead: they accept EITHER a personal `mcp_tokens` token (Settings →
// Connect Claude / the API page) OR a Supabase session JWT (verified via
// auth.getUser — never trusted from its payload, since verify_jwt is off).
//
// `run-tool` already accepted both; `artifacts` and `todos` used to accept only
// an mcp_token, so a caller authenticating those with a valid session token got
// a 401 "Invalid token" while the same token worked on run-tool. Sharing one
// resolver keeps the three APIs consistent — one token works everywhere.

// deno-lint-ignore no-explicit-any
type DB = any

/** Strip a leading `Bearer` keyword (any case) and surrounding whitespace from
 * an Authorization header, leaving the bare token. A header with no `Bearer`
 * prefix is treated as the token itself. Returns '' when there's nothing usable.
 * The `\b` keeps a token that merely starts with "bearer" (e.g. a random token)
 * intact — only the standalone keyword is removed. Pure. */
export function parseBearer(authHeader: string | null | undefined): string {
  return (authHeader ?? '').trim().replace(/^Bearer\b\s*/i, '').trim()
}

/**
 * Resolve a bearer token to a user id. Tries an `mcp_tokens` token first
 * (bumping its `last_used_at`), then falls back to verifying the token as a
 * Supabase session JWT via `auth.getUser`. Returns null when neither resolves.
 */
export async function resolveApiUser(db: DB, token: string): Promise<string | null> {
  if (!token) return null
  const { data: tok } = await db.from('mcp_tokens').select('owner_id').eq('token', token).maybeSingle()
  if (tok?.owner_id) {
    db.from('mcp_tokens').update({ last_used_at: new Date().toISOString() }).eq('token', token).then(() => {})
    return tok.owner_id as string
  }
  try {
    const { data } = await db.auth.getUser(token)
    return data?.user?.id ?? null
  } catch {
    return null
  }
}
