// Pure helpers for the PDF knowledge-base indexing pipeline (the `documents`
// table). The ingest edge function advances a doc through
// pending → processing → done | error; re-indexing just resets it back to
// `pending`, and the cron tick (0100_ingest_automation_cron) picks it up again.
// The PARSE phase deletes any existing chunks before re-inserting, so resetting
// status is enough — no chunk cleanup needed on the client.

export type DocStatus = 'pending' | 'processing' | 'done' | 'error'

/** The row patch that queues a document for (re-)indexing from scratch. */
export function reindexDocPatch(): { status: DocStatus; error: null; chunk_count: number } {
  return { status: 'pending', error: null, chunk_count: 0 }
}

/**
 * Whether to offer a re-index control. Any file-backed doc in a known state can
 * be re-queued — including one stuck on `pending`/`processing` (the exact case
 * this button exists for: indexing that never finished). Guards against a
 * missing doc or an unrecognized status.
 */
export function canReindex(status: string | null | undefined): boolean {
  return (
    status === 'pending' ||
    status === 'processing' ||
    status === 'done' ||
    status === 'error'
  )
}

/** Button/tooltip label — "Retry" reads better on a failed doc than "Re-index". */
export function reindexActionLabel(status: string | null | undefined): string {
  return status === 'error' ? 'Retry indexing' : 'Re-index'
}
