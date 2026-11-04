// The contract every backend implements. Pages talk to these interfaces (via
// ./index.ts), never to Supabase directly, so the hosted build (Supabase) and
// the local build (SQLite sidecar) can share every page.
//
// Conventions:
// - Reads resolve to data; any backend error is thrown.
// - Writes act as the current user. Backends that have users (Supabase) fill
//   owner/added_by themselves; single-user backends ignore them.
import type { Collection, CollectionItemKind, Membership, NewTerm, Term, TermPatch } from './types'

export interface TerminologyStore {
  /** All terms visible to the current user, sorted by term. */
  list(): Promise<Term[]>
  /** One term, or null when it doesn't exist or isn't visible. */
  get(id: string): Promise<Term | null>
  create(input: NewTerm): Promise<Term>
  update(id: string, patch: TermPatch): Promise<void>
  remove(id: string): Promise<void>
}

export interface CollectionStore {
  /** All visible collections, pinned first, then by name. */
  list(): Promise<Collection[]>
  /**
   * Membership rows for one item kind. Pass `itemIds` to limit the result to
   * those items; omit it for every membership of that kind.
   */
  memberships(kind: CollectionItemKind, itemIds?: string[]): Promise<Membership[]>
  /** Create a private collection owned by the current user. */
  create(input: { name: string }): Promise<Collection>
  /** File items into a collection. Adding an item twice is a no-op. */
  addItems(kind: CollectionItemKind, collectionId: string, itemIds: string[]): Promise<void>
  removeItems(kind: CollectionItemKind, collectionId: string, itemIds: string[]): Promise<void>
}

export interface Backend {
  name: 'supabase' | 'memory' | 'local'
  terminology: TerminologyStore
  collections: CollectionStore
}
