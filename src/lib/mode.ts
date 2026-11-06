// Which build this is. `VITE_BACKEND=local` runs the UI against the local
// second-brain server (local/server.ts, SQLite) instead of Supabase; see
// docs/local-first.md. Anything else is the hosted build.
export const isLocalMode = import.meta.env.VITE_BACKEND === 'local'

/**
 * Routes that work on the local backend so far. Grows as each domain moves
 * onto src/lib/data. Everything else shows a "not available locally yet"
 * page in local mode instead of failing against a Supabase that isn't there.
 */
export const LOCAL_READY_ROUTES = ['/terminology'] as const

/** Where local mode lands when you open the app. */
export const LOCAL_HOME = '/terminology'

export function isLocalReady(pathname: string): boolean {
  return LOCAL_READY_ROUTES.some((r) => pathname === r || pathname.startsWith(`${r}/`))
}
