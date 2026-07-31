// Pure helpers for the Files bulk-share UI. Kept out of the component so the
// share-mode → expiry mapping (the one bit of real logic) is unit-testable.

export const PUBLIC_FILES_BUCKET = 'public-files'

// The four share modes offered in the bulk bar. 'public' publishes the file to
// the public bucket for a stable, non-expiring URL; the rest mint a signed URL
// that expires after the given window.
export type ShareMode = 'public' | '1h' | '1d' | '1w'

const HOUR = 60 * 60

// Expiry in seconds for a signed-URL share mode. 'public' has no expiry, so it
// is not a signed mode and returns null.
export function shareExpirySeconds(mode: ShareMode): number | null {
  switch (mode) {
    case '1h':
      return HOUR
    case '1d':
      return HOUR * 24
    case '1w':
      return HOUR * 24 * 7
    case 'public':
      return null
  }
}

// Human label for a share mode (buttons + result copy).
export function shareModeLabel(mode: ShareMode): string {
  switch (mode) {
    case 'public':
      return 'Public'
    case '1h':
      return '1 hour'
    case '1d':
      return '1 day'
    case '1w':
      return '1 week'
  }
}

// A short sentence describing how long a share stays valid, for the results toast.
export function shareValidityNote(mode: ShareMode): string {
  return mode === 'public'
    ? 'Public — a permanent link anyone can open.'
    : `Signed link — valid for ${shareModeLabel(mode)}.`
}

// Buttons render in this order.
export const SHARE_MODES: ShareMode[] = ['public', '1h', '1d', '1w']
