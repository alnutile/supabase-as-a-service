// Pure logic behind the shared collection picker (src/components/CollectionPicker.tsx).
//
// The picker replaces the "chip wall" every collection-aware page grew: one
// button per collection, wrapped over four or five lines once a workspace has
// fifty-odd collections. Filtering, the empty-collection rule and the selection
// maths live here so they're unit-testable and identical on every page.

export type PickableCollection = { id: string; name: string }

// How many items each collection holds on the current page (collection id →
// count). A page that doesn't track counts passes nothing and every collection
// reads as "unknown" (never hidden by the empty filter).
export type CollectionCounts = Record<string, number> | undefined

export function collectionCount(counts: CollectionCounts, id: string): number | null {
  if (!counts) return null
  return counts[id] ?? 0
}

// Collections with a known count of zero. These are hidden by default — a
// workspace accretes empty collections (six duplicate "SupaNet Docs" rows), and
// they're noise in a filter list where picking one shows nothing.
export function emptyCollectionCount<T extends PickableCollection>(
  collections: T[],
  counts: CollectionCounts,
): number {
  if (!counts) return 0
  return collections.filter((c) => (counts[c.id] ?? 0) === 0).length
}

// The visible rows: name substring match, plus the empty rule. A SELECTED
// collection always stays visible even when empty — hiding the row you just
// ticked (because filtering emptied it) is the confusing case.
export function filterCollections<T extends PickableCollection>(
  collections: T[],
  opts: { query?: string; showEmpty?: boolean; counts?: CollectionCounts; selected?: ReadonlySet<string> },
): T[] {
  const q = (opts.query ?? '').trim().toLowerCase()
  return collections.filter((c) => {
    if (q && !c.name.toLowerCase().includes(q)) return false
    if (opts.showEmpty || !opts.counts) return true
    if (opts.selected?.has(c.id)) return true
    return (opts.counts[c.id] ?? 0) > 0
  })
}

// Add/remove one id, returning a NEW set (React state is replaced, not mutated).
export function toggleId(selected: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(selected)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  return next
}

// The label on the trigger button: the collection's name when exactly one is
// picked (the common case — you want to see WHICH), a count beyond that.
export function triggerLabel<T extends PickableCollection>(
  collections: T[],
  selected: ReadonlySet<string>,
): string {
  if (selected.size === 0) return 'Collections'
  if (selected.size === 1) {
    const id = [...selected][0]
    const hit = collections.find((c) => c.id === id)
    if (hit) return hit.name
  }
  return `${selected.size} collections`
}
