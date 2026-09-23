// Stored connection settings. `chrome.storage.local` (not `sync`) on purpose:
// the connection token is a credential, and syncing it would copy it to every
// Chrome profile signed into the same Google account.

export const DEFAULTS = {
  baseUrl: '', // https://<project>.supabase.co
  token: '', // a personal connection token (Settings -> Connect Claude)
  appUrl: '', // optional: the intranet's own URL, so results can link into it
  lastMode: 'article', // 'article' | 'link'
  lastCollection: '', // a collection id, remembered between saves
}

export async function loadSettings() {
  const stored = await chrome.storage.local.get(DEFAULTS)
  return { ...DEFAULTS, ...stored }
}

export async function saveSettings(patch) {
  await chrome.storage.local.set(patch)
}

/** True when there is enough to talk to a workspace. */
export function isConnected(settings) {
  return Boolean(settings?.baseUrl && settings?.token)
}
