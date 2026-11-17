// Domain types for the data layer. They alias the generated Supabase row types
// for now so the hosted build keeps one source of truth; the local (SQLite)
// backend implements the same shapes.
import type { Database } from '../database.types'

type Tables = Database['public']['Tables']

export type Term = Tables['terminology']['Row']
export type TermPatch = Partial<Pick<Term, 'term' | 'definition' | 'notes' | 'visibility'>>
export type NewTerm = { term: string; definition: string; notes?: string }

export type Collection = Tables['collections']['Row']

/** Every kind of item that can be filed into a collection. */
export type CollectionItemKind =
  | 'artifact'
  | 'file'
  | 'table'
  | 'todo'
  | 'link'
  | 'term'
  | 'whiteboard'
  | 'card_board'

/** One "item X is in collection Y" row, whatever the item kind. */
export type Membership = { collectionId: string; itemId: string }
