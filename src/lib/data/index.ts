// The app's data layer. Pages import from here instead of calling Supabase, so
// the same UI runs on the hosted backend (Supabase) or the local one (SQLite
// sidecar, see docs/local-first.md).
//
//   import { data } from '../lib/data'
//   const terms = await data.terminology.list()
//
// main.tsx picks the backend once at startup with setBackend(). This module
// deliberately does not import any backend itself, so the local build never
// loads the Supabase client and tests can run without Supabase env vars.
// `data` always forwards to the current backend, so tests can swap it with
// setBackend(createMemoryBackend(...)) without re-importing anything.
import type { Backend } from './stores'

let current: Backend | null = null

export function getBackend(): Backend {
  if (!current) throw new Error('No data backend configured; call setBackend() at startup (see main.tsx).')
  return current
}

/** Choose the backend (main.tsx at startup, and tests). */
export function setBackend(next: Backend): void {
  current = next
}

export const data: Omit<Backend, 'name'> = {
  get terminology() {
    return getBackend().terminology
  },
  get collections() {
    return getBackend().collections
  },
}

export type { Backend, CollectionStore, TerminologyStore } from './stores'
export type * from './types'
