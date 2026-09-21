// The browser tab title. Once an admin sets the workspace's organization name
// (Settings → Organization, migration 0125), it leads the title so someone with
// several SupaNet tabs open can tell the workspaces apart from the tab strip
// alone — the same reason the name shows on the home page.
//
// Absence of a name (a fresh workspace, or a blank value) = the plain app name,
// so nothing changes until someone opts in.
export const APP_NAME = 'SupaNet'

const SEPARATOR = ' · '

// Collapse whitespace so a pasted name with newlines/tabs doesn't render as a
// ragged title, and cap it — a very long name pushes the app name out of the
// visible part of the tab, which is exactly what the title is for.
const MAX_ORG_CHARS = 60

export function appTitle(orgName?: string | null): string {
  const org = (orgName ?? '').replace(/\s+/g, ' ').trim()
  if (!org) return APP_NAME
  const clipped = org.length > MAX_ORG_CHARS ? `${org.slice(0, MAX_ORG_CHARS - 1).trimEnd()}…` : org
  // A workspace literally named after the app shouldn't read "SupaNet · SupaNet".
  if (clipped.toLowerCase() === APP_NAME.toLowerCase()) return APP_NAME
  return `${clipped}${SEPARATOR}${APP_NAME}`
}
