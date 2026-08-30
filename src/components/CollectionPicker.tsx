import { useEffect, useMemo, useRef, useState } from 'react'
import {
  collectionCount,
  emptyCollectionCount,
  filterCollections,
  toggleId,
  triggerLabel,
  type CollectionCounts,
  type PickableCollection,
} from '../lib/collectionPicker'
import { CheckIcon, ChevronDownIcon, CloseIcon, CollectionIcon, SearchIcon } from './icons'

/**
 * The shared collection FILTER control.
 *
 * Every collection-aware page (to-dos, artifacts, links, terminology, agents)
 * used to render one pill per collection in a wrapping row. That reads fine
 * with six collections and falls apart at fifty: five lines of chips above the
 * content, no way to find one by name, and empty collections taking up as much
 * room as the ones you actually use.
 *
 * This is one button that opens a searchable, counted list — and, underneath,
 * a token row showing only what you picked. Selection is a Set of collection
 * ids in either mode; `mode="single"` just replaces rather than accumulates, so
 * a page can adopt the control without changing its filtering semantics.
 */
export function CollectionPicker({
  collections,
  selected,
  onChange,
  counts,
  mode = 'multi',
  totalLabel,
  align = 'left',
}: {
  collections: PickableCollection[]
  selected: Set<string>
  onChange: (next: Set<string>) => void
  /** collection id → item count on this page. Drives the counts and the "show empty" rule. */
  counts?: CollectionCounts
  mode?: 'single' | 'multi'
  /** Optional "All (n)" count shown on the reset row. */
  totalLabel?: string
  align?: 'left' | 'right'
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [showEmpty, setShowEmpty] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const list = useMemo(
    () => filterCollections(collections, { query, showEmpty, counts, selected }),
    [collections, query, showEmpty, counts, selected],
  )
  const emptyCount = useMemo(() => emptyCollectionCount(collections, counts), [collections, counts])

  function toggle(id: string) {
    if (mode === 'single') onChange(selected.has(id) ? new Set() : new Set([id]))
    else onChange(toggleId(selected, id))
  }

  if (collections.length === 0) return null

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium transition ${
          selected.size > 0 || open
            ? 'border-primary bg-primary-soft text-primary'
            : 'border-border text-muted hover:bg-surface-hover'
        }`}
      >
        <CollectionIcon className="h-4 w-4 shrink-0" />
        <span className="max-w-[12rem] truncate">{triggerLabel(collections, selected)}</span>
        {selected.size > 1 && (
          <span className="flex h-5 min-w-[1.25rem] items-center justify-center rounded-full bg-primary px-1.5 text-[11px] font-bold text-white">
            {selected.size}
          </span>
        )}
        <ChevronDownIcon className={`h-3.5 w-3.5 shrink-0 transition ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div
          className={`absolute z-40 mt-2 w-80 max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-border bg-surface shadow-xl ${
            align === 'right' ? 'right-0' : 'left-0'
          }`}
        >
          <div className="border-b border-border p-2.5">
            <div className="relative">
              <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-faint" />
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Filter collections…"
                className="w-full rounded-lg border border-border-strong bg-surface py-2 pl-8 pr-2 text-sm outline-none focus:border-primary focus:ring-1 focus:ring-primary-soft"
              />
            </div>
          </div>

          <div className="max-h-72 overflow-y-auto p-1.5">
            {selected.size > 0 && (
              <button
                onClick={() => onChange(new Set())}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm font-medium text-muted hover:bg-surface-hover"
              >
                <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                  <CloseIcon className="h-3.5 w-3.5" />
                </span>
                Show all{totalLabel ? ` (${totalLabel})` : ''}
              </button>
            )}
            {list.map((c) => {
              const n = collectionCount(counts, c.id)
              const on = selected.has(c.id)
              return (
                <button
                  key={c.id}
                  onClick={() => toggle(c.id)}
                  className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm hover:bg-surface-hover"
                >
                  <span
                    className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
                      on ? 'border-primary bg-primary text-white' : 'border-border-strong text-transparent'
                    }`}
                  >
                    <CheckIcon className="h-3 w-3" />
                  </span>
                  <span className={`min-w-0 flex-1 truncate ${on ? 'font-semibold text-text' : 'text-text'}`}>
                    {c.name}
                  </span>
                  {n !== null && (
                    <span className={`shrink-0 text-xs font-semibold ${n ? 'text-faint' : 'text-border-strong'}`}>
                      {n}
                    </span>
                  )}
                </button>
              )
            })}
            {list.length === 0 && (
              <p className="px-2 py-6 text-center text-sm text-muted">
                {query.trim() ? `No collection matches “${query.trim()}”.` : 'No collections with items yet.'}
              </p>
            )}
          </div>

          {emptyCount > 0 && (
            <div className="flex items-center justify-between gap-2 border-t border-border px-2.5 py-2">
              <button
                onClick={() => setShowEmpty((v) => !v)}
                className="flex items-center gap-2 text-xs font-semibold text-muted hover:text-text"
              >
                <span
                  className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border ${
                    showEmpty ? 'border-primary bg-primary text-white' : 'border-border-strong text-transparent'
                  }`}
                >
                  <CheckIcon className="h-2.5 w-2.5" />
                </span>
                Show empty ({emptyCount})
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * The row of removable tokens for what's currently picked. Sits under the
 * toolbar so the selection stays visible once the popover closes — the one
 * thing the old chip wall did well.
 */
export function CollectionTokens({
  collections,
  selected,
  onChange,
  counts,
}: {
  collections: PickableCollection[]
  selected: Set<string>
  onChange: (next: Set<string>) => void
  counts?: CollectionCounts
}) {
  if (selected.size === 0) return null
  const picked = collections.filter((c) => selected.has(c.id))
  return (
    <div className="flex flex-wrap items-center gap-2">
      {picked.map((c) => {
        const n = collectionCount(counts, c.id)
        return (
          <span
            key={c.id}
            className="flex items-center gap-1.5 rounded-full border border-primary-soft-border bg-primary-soft py-1 pl-3 pr-1 text-xs font-semibold text-primary"
          >
            {c.name}
            {n !== null && <span className="font-medium opacity-70">{n}</span>}
            <button
              onClick={() => onChange(toggleId(selected, c.id))}
              title={`Remove ${c.name}`}
              aria-label={`Remove ${c.name}`}
              className="flex h-4 w-4 items-center justify-center rounded-full opacity-70 hover:opacity-100"
            >
              <CloseIcon className="h-3 w-3" />
            </button>
          </span>
        )
      })}
      {selected.size > 1 && (
        <button onClick={() => onChange(new Set())} className="text-xs font-semibold text-muted hover:text-text">
          Clear all
        </button>
      )}
    </div>
  )
}
