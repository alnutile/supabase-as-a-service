// Pure list-merge helpers for the Features board's Realtime subscription.
// Kept out of the component so the upsert/remove/sort logic is unit-testable.
// The board renders `features` ordered by `updated_at` descending (newest edit
// first), the same order the initial `load()` query uses.

export interface FeatureLike {
  id: string
  updated_at: string
}

/**
 * Insert or replace `row` in `list` by id, then sort by `updated_at` descending.
 * Used for Realtime INSERT and UPDATE events — an UPDATE replaces the stale copy
 * (e.g. a freshly-synced PR link), an INSERT for an unseen id just adds it.
 */
export function upsertFeature<T extends FeatureLike>(list: T[], row: T): T[] {
  const without = list.filter((f) => f.id !== row.id)
  return [row, ...without].sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at))
}

/** Drop the row with `id` from `list` (Realtime DELETE event). */
export function removeFeature<T extends { id: string }>(list: T[], id: string): T[] {
  return list.filter((f) => f.id !== id)
}
