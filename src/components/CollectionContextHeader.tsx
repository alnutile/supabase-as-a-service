import { Link } from 'react-router-dom'
import { ArrowRightIcon, CollectionIcon, CloseIcon } from './icons'

/**
 * Collection context header — shown when viewing a filtered page from a collection.
 *
 * When a user navigates from a collection dashboard to a full page (Links, Artifacts,
 * Todos, Files), this header appears to:
 * 1. Show which collection is active
 * 2. Provide a link back to the collection dashboard
 * 3. Allow clearing the filter to view all items
 */
export function CollectionContextHeader({
  collectionId,
  collectionName,
  onClear,
}: {
  collectionId: string
  collectionName: string
  /** Called when the user clicks the X to clear the collection filter */
  onClear: () => void
}) {
  return (
    <div className="border-b border-primary/20 bg-primary-soft/40 px-3 py-2 sm:px-5">
      <div className="flex items-center gap-3">
        <CollectionIcon className="h-4 w-4 shrink-0 text-primary" />
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span className="text-sm text-muted">Viewing:</span>
          <Link
            to={`/collections/${collectionId}`}
            className="group flex items-center gap-1.5 rounded-md px-2 py-1 text-sm font-medium text-primary transition hover:bg-primary-soft"
          >
            <span className="truncate">{collectionName}</span>
            <ArrowRightIcon className="h-3.5 w-3.5 opacity-0 transition group-hover:opacity-100" />
          </Link>
        </div>
        <button
          onClick={onClear}
          title="View all items"
          className="flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-sm text-muted transition hover:bg-surface-hover hover:text-text"
        >
          <CloseIcon className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">Clear filter</span>
        </button>
      </div>
    </div>
  )
}
