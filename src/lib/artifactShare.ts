// Pure helpers for the optional "password on a shared artifact" feature
// (migration 0060). Kept out of the pages so the branching logic is unit-tested.

export const MIN_SHARE_PASSWORD_LENGTH = 4

// Validate a password the owner is about to set on a shared artifact.
// Returns an error message, or null when it's acceptable. All-whitespace counts
// as empty (the RPC treats a blank value as "clear the password").
export function validateSharePassword(password: string): string | null {
  const pw = password ?? ''
  if (pw.trim().length === 0) return 'Enter a password.'
  if (pw.length < MIN_SHARE_PASSWORD_LENGTH)
    return `Use at least ${MIN_SHARE_PASSWORD_LENGTH} characters.`
  return null
}

export type ShareMeta = { found: boolean; requires_password: boolean }

export type ShareGate = 'ready' | 'password' | 'missing'

// A viewer page first tries a normal RLS read. When that returns nothing the
// row is either private/absent OR password-protected (hidden from anon). This
// maps the `artifact_share_meta` result to what the page should show next.
export function shareGateFromMeta(meta: ShareMeta | null | undefined): ShareGate {
  if (!meta || !meta.found) return 'missing'
  return meta.requires_password ? 'password' : 'ready'
}
