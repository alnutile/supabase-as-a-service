import { useCallback, useEffect, useState } from 'react'
import { data, type Collection, type CollectionItemKind } from '../lib/data'
import { CheckIcon, CollectionIcon, PlusIcon } from './icons'

/**
 * Inline collections picker for a single item. Shows which collections the item
 * is in and allows adding/removing it. Used in item editors (artifacts, etc.)
 * where you want to manage collection membership without leaving the page.
 */
export function CollectionSelector({
  itemId,
  itemType,
}: {
  itemId: string
  itemType: CollectionItemKind
}) {
  const [collections, setCollections] = useState<Collection[]>([])
  const [memberCollections, setMemberCollections] = useState<Set<string>>(new Set())
  const [showAdd, setShowAdd] = useState(false)
  const [newName, setNewName] = useState('')
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    // Load all collections and which ones contain this item
    const [collectionRows, memberRows] = await Promise.all([
      data.collections.list().catch(() => []),
      data.collections.memberships(itemType, [itemId]).catch(() => []),
    ])
    setCollections(collectionRows)
    setMemberCollections(new Set(memberRows.map((row) => row.collectionId)))
  }, [itemType, itemId])

  useEffect(() => {
    refresh()
  }, [refresh])

  async function toggle(collectionId: string) {
    if (busy) return
    setBusy(true)
    const adding = !memberCollections.has(collectionId)
    try {
      if (adding) {
        await data.collections.addItems(itemType, collectionId, [itemId])
        setMemberCollections((prev) => new Set([...prev, collectionId]))
      } else {
        await data.collections.removeItems(itemType, collectionId, [itemId])
        setMemberCollections((prev) => {
          const next = new Set(prev)
          next.delete(collectionId)
          return next
        })
      }
    } finally {
      setBusy(false)
    }
  }

  async function createCollection() {
    const name = newName.trim()
    if (!name || busy) return
    setBusy(true)
    try {
      const created = await data.collections.create({ name })
      setCollections((prev) => [...prev, created].sort((a, b) => a.name.localeCompare(b.name)))
      setNewName('')
      // Add the item to the new collection
      await data.collections.addItems(itemType, created.id, [itemId])
      setMemberCollections((prev) => new Set([...prev, created.id]))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-2">
      {memberCollections.size > 0 && (
        <div className="space-y-1">
          {collections
            .filter((c) => memberCollections.has(c.id))
            .map((c) => (
              <button
                key={c.id}
                onClick={() => toggle(c.id)}
                disabled={busy}
                className="flex w-full items-center gap-2 rounded-lg border border-border bg-surface px-2.5 py-2 text-left text-sm hover:bg-surface-hover disabled:opacity-50"
                title="Click to remove from this collection"
              >
                <CheckIcon className="h-3.5 w-3.5 shrink-0 text-primary" />
                <CollectionIcon className="h-3.5 w-3.5 shrink-0 text-faint" />
                <span className="min-w-0 flex-1 truncate text-text">{c.name}</span>
              </button>
            ))}
        </div>
      )}

      {showAdd ? (
        <div className="space-y-1.5 rounded-lg border border-border bg-surface p-2">
          {collections.filter((c) => !memberCollections.has(c.id)).length > 0 && (
            <div className="max-h-48 space-y-0.5 overflow-y-auto">
              {collections
                .filter((c) => !memberCollections.has(c.id))
                .map((c) => (
                  <button
                    key={c.id}
                    onClick={() => toggle(c.id)}
                    disabled={busy}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-surface-hover disabled:opacity-50"
                  >
                    <CollectionIcon className="h-3.5 w-3.5 shrink-0 text-faint" />
                    <span className="min-w-0 flex-1 truncate text-text">{c.name}</span>
                  </button>
                ))}
            </div>
          )}
          <div className="flex items-center gap-1.5 border-t border-border pt-1.5">
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  createCollection()
                } else if (e.key === 'Escape') {
                  e.preventDefault()
                  setShowAdd(false)
                  setNewName('')
                }
              }}
              placeholder="New collection…"
              autoFocus
              className="min-w-0 flex-1 rounded-md border border-border-strong px-2 py-1.5 text-sm outline-none focus:border-primary focus:ring-1 focus:ring-primary-soft"
            />
            <button
              onClick={createCollection}
              disabled={!newName.trim() || busy}
              className="shrink-0 rounded-md bg-primary px-2.5 py-1.5 text-sm font-semibold text-white transition hover:bg-primary-strong disabled:opacity-50"
            >
              Add
            </button>
          </div>
          <button
            onClick={() => {
              setShowAdd(false)
              setNewName('')
            }}
            className="w-full rounded-md px-2 py-1.5 text-center text-xs font-medium text-muted hover:text-text"
          >
            Cancel
          </button>
        </div>
      ) : (
        <button
          onClick={() => setShowAdd(true)}
          className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-border px-3 py-2 text-sm font-medium text-muted transition hover:border-primary hover:text-primary"
        >
          <PlusIcon className="h-4 w-4" />
          Add to collection
        </button>
      )}
    </div>
  )
}
