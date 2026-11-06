import type { CollectionItemKind } from '../types'

// The join table + item column each collection item kind uses in Postgres.
// All join tables share the shape {collection_id, <item>_id, added_by, created_at}.
export const COLLECTION_JOIN: Record<CollectionItemKind, { table: string; col: string }> = {
  artifact: { table: 'collection_artifacts', col: 'artifact_id' },
  file: { table: 'collection_files', col: 'file_id' },
  table: { table: 'collection_tables', col: 'table_id' },
  todo: { table: 'collection_todos', col: 'todo_id' },
  link: { table: 'collection_links', col: 'link_id' },
  term: { table: 'collection_terminology', col: 'term_id' },
  whiteboard: { table: 'collection_whiteboards', col: 'whiteboard_id' },
  card_board: { table: 'collection_card_boards', col: 'card_board_id' },
}
