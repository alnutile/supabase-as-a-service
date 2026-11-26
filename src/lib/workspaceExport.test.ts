import { describe, expect, it } from 'vitest'
import {
  artifactToMarkdown,
  buildExportEntries,
  cardBoardToMarkdown,
  collectionsToMarkdown,
  conversationToMarkdown,
  fence,
  frontMatter,
  linksToMarkdown,
  memoriesToMarkdown,
  safeFileStem,
  todosToMarkdown,
  uniquePathAllocator,
  whiteboardToExcalidraw,
  type ExportArtifact,
  type ExportCardBoard,
  type ExportData,
  type ExportLink,
  type ExportMessage,
  type ExportTodo,
  type ExportWhiteboard,
} from './workspaceExport'

const T = '2026-11-01T10:00:00.000Z'

const artifact = (o: Partial<ExportArtifact> = {}): ExportArtifact => ({
  id: 'a1', owner_id: 'u', conversation_id: null, title: 'Plan', type: 'markdown', language: null,
  content: 'Body', visibility: 'private', public_slug: null, data: {}, share_password_hash: null,
  pinned: false, deleted_at: null, created_at: T, updated_at: T, ...o,
})
const link = (o: Partial<ExportLink> = {}): ExportLink => ({
  id: 'l1', owner_id: 'u', url: 'https://x.dev', title: 'X', description: '', image_url: null,
  favicon_url: null, screenshot_path: null, notes: '', visibility: 'private', tags: null,
  created_at: T, updated_at: T, ...o,
})
const todo = (o: Partial<ExportTodo> = {}): ExportTodo => ({
  id: 't1', owner_id: 'u', title: 'Ship it', notes: '', due_date: null, done: false, status: 'next',
  source: null, completed_at: null, position: 0, visibility: 'private', created_at: T, updated_at: T, ...o,
})
const msg = (o: Partial<ExportMessage> = {}): ExportMessage => ({
  id: 'm1', conversation_id: 'c1', owner_id: 'u', role: 'user', content: 'hi', attachments: null,
  metadata: {}, created_at: T, ...o,
})
const board = (o: Partial<ExportCardBoard> = {}): ExportCardBoard => ({
  id: 'b1', owner_id: 'u', title: 'Ideas', cards: [], visibility: 'private', created_at: T, updated_at: T, ...o,
})
const wb = (o: Partial<ExportWhiteboard> = {}): ExportWhiteboard => ({
  id: 'w1', owner_id: 'u', title: 'Flow', scene: {}, visibility: 'private', created_at: T, updated_at: T, ...o,
})

const empty = (): ExportData => ({
  artifacts: [], links: [], conversations: [], messages: [], whiteboards: [], cardBoards: [],
  todos: [], memories: [], collections: [], memberships: [],
})

describe('safeFileStem', () => {
  it('strips path separators and reserved chars, keeps unicode', () => {
    expect(safeFileStem('a/b:c*?"<>|d')).toBe('a b c d')
    expect(safeFileStem('Café ☕')).toBe('Café ☕')
    expect(safeFileStem('..hidden.')).toBe('hidden')
    expect(safeFileStem('   ')).toBe('untitled')
    expect(safeFileStem('x'.repeat(200)).length).toBe(80)
  })
})

describe('uniquePathAllocator', () => {
  it('suffixes duplicates case-insensitively per folder', () => {
    const alloc = uniquePathAllocator()
    expect(alloc('artifacts', 'Notes', '.md')).toBe('artifacts/Notes.md')
    expect(alloc('artifacts', 'notes', '.md')).toBe('artifacts/notes (2).md')
    expect(alloc('artifacts', 'Notes', '.md')).toBe('artifacts/Notes (3).md')
    expect(alloc('chats', 'Notes', '.md')).toBe('chats/Notes.md')
  })
})

describe('frontMatter / fence', () => {
  it('quotes strings and skips empties', () => {
    expect(frontMatter({ title: 'a: "b"', n: 2, none: null, tags: [], cols: ['x'] })).toBe(
      '---\ntitle: "a: \\"b\\""\nn: 2\ncols: ["x"]\n---',
    )
  })
  it('uses a fence longer than any inside the body', () => {
    expect(fence('```js\nx\n```', 'md')).toBe('````md\n```js\nx\n```\n````')
    expect(fence('plain')).toBe('```\nplain\n```')
  })
})

describe('artifactToMarkdown', () => {
  it('writes front matter + heading + body', () => {
    const md = artifactToMarkdown(artifact(), ['Research'])
    expect(md).toContain('title: "Plan"')
    expect(md).toContain('collections: ["Research"]')
    expect(md).toContain('# Plan\n\nBody')
  })
  it('fences code and html', () => {
    expect(artifactToMarkdown(artifact({ type: 'code', language: 'ts', content: 'let x' }))).toContain('```ts\nlet x\n```')
    expect(artifactToMarkdown(artifact({ type: 'html', content: '<p>' }))).toContain('```html\n<p>\n```')
  })
})

describe('conversationToMarkdown', () => {
  it('orders messages and lists attachments', () => {
    const md = conversationToMarkdown(
      { id: 'c1', owner_id: 'u', title: 'Chat', pinned: false, card_board_id: null, meeting_id: null,
        cancel_requested_run: null, created_at: T, updated_at: T },
      [
        msg({ id: 'm2', role: 'assistant', content: 'second', created_at: '2026-11-01T10:05:00Z' }),
        msg({ attachments: [{ name: 'spec.pdf', path: 'x' }] }),
      ],
    )
    expect(md.indexOf('## User')).toBeLessThan(md.indexOf('## Assistant'))
    expect(md).toContain('_Attachments: spec.pdf_')
    expect(md).toContain('messages: 2')
  })
})

describe('whiteboardToExcalidraw', () => {
  it('wraps the scene as an excalidraw file and drops collaborators', () => {
    const file = JSON.parse(whiteboardToExcalidraw(wb({
      scene: { elements: [{ id: 'e' }], appState: { viewBackgroundColor: '#fff', collaborators: {} }, files: {} },
    })))
    expect(file.type).toBe('excalidraw')
    expect(file.elements).toEqual([{ id: 'e' }])
    expect(file.appState).toEqual({ viewBackgroundColor: '#fff' })
  })
  it('tolerates an empty / malformed scene', () => {
    const file = JSON.parse(whiteboardToExcalidraw(wb({ scene: null as never })))
    expect(file.elements).toEqual([])
    expect(file.files).toEqual({})
  })
})

describe('cardBoardToMarkdown', () => {
  it('orders cards top-to-bottom then left-to-right and skips blanks', () => {
    const md = cardBoardToMarkdown(board({
      cards: [
        { text: 'low', color: 'blue', x: 0, y: 500 },
        { text: 'right', color: '', x: 400, y: 10 },
        { text: 'top', color: 'yellow', x: 0, y: 10 },
        { text: '  ', x: 0, y: 0 },
      ],
    }))
    expect(md).toContain('1. top _(yellow)_\n2. right\n3. low _(blue)_')
    expect(md).toContain('cards: 3')
  })
})

describe('linksToMarkdown / todosToMarkdown / memoriesToMarkdown', () => {
  it('lists links newest first with collections', () => {
    const md = linksToMarkdown(
      [link(), link({ id: 'l2', title: 'New [one]', created_at: '2026-11-20T00:00:00Z', notes: 'read' })],
      new Map([['link:l2', ['Reading']]]),
    )
    expect(md.indexOf('New one')).toBeLessThan(md.indexOf('[X]'))
    expect(md).toContain('Notes: read')
    expect(md).toContain('collections: Reading')
  })
  it('groups to-dos by lane with checkboxes', () => {
    const md = todosToMarkdown([
      todo({ id: 'a', title: 'done one', done: true, status: 'done', completed_at: T }),
      todo({ id: 'b', title: 'doing one', status: 'doing', due_date: '2026-12-01', visibility: 'workspace' }),
      todo({ id: 'c', title: 'next one', notes: 'line1\nline2' }),
    ])
    expect(md).toContain('2 open, 1 done.')
    expect(md.indexOf('## Doing')).toBeLessThan(md.indexOf('## Next'))
    expect(md.indexOf('## Next')).toBeLessThan(md.indexOf('## Done'))
    expect(md).toContain('- [ ] doing one _(due 2026-12-01 · team)_')
    expect(md).toContain('- [x] done one _(completed 2026-11-01)_')
    expect(md).toContain('- [ ] next one\n  line1\n  line2')
  })
  it('groups memories by category, pinned first', () => {
    const md = memoriesToMarkdown([
      { id: '1', owner_id: 'u', content: 'likes tea', key: null, category: 'prefs', pinned: false, source: {}, created_at: T, updated_at: T },
      { id: '2', owner_id: 'u', content: 'name is Sam', key: null, category: 'prefs', pinned: true, source: {}, created_at: T, updated_at: T },
    ])
    expect(md.indexOf('name is Sam')).toBeLessThan(md.indexOf('likes tea'))
    expect(md).toContain('## prefs')
  })
})

describe('collectionsToMarkdown', () => {
  it('lists member titles per kind and marks empty collections', () => {
    const data = empty()
    data.artifacts = [artifact()]
    data.todos = [todo()]
    data.collections = [
      { id: 'k1', owner_id: 'u', name: 'Launch', description: 'Q1', color: null, visibility: 'private', pinned: false, created_at: T, updated_at: T },
      { id: 'k2', owner_id: 'u', name: 'Empty', description: '', color: null, visibility: 'private', pinned: false, created_at: T, updated_at: T },
    ]
    data.memberships = [
      { collection_id: 'k1', kind: 'artifact', item_id: 'a1' },
      { collection_id: 'k1', kind: 'todo', item_id: 't1' },
      { collection_id: 'k1', kind: 'link', item_id: 'gone' },
    ]
    const md = collectionsToMarkdown(data)
    expect(md).toContain('## Launch\n\nQ1\n\n**Artifacts**\n\n- Plan\n\n**To-dos**\n\n- Ship it')
    expect(md).not.toContain('**Links**')
    expect(md).toContain('## Empty\n\n_(empty)_')
  })
})

describe('buildExportEntries', () => {
  it('lays out every area, dedupes names, skips archived artifacts', () => {
    const data = empty()
    data.artifacts = [artifact(), artifact({ id: 'a2' }), artifact({ id: 'a3', title: 'Old', deleted_at: T })]
    data.conversations = [{ id: 'c1', owner_id: 'u', title: 'Hello', pinned: false, card_board_id: null, meeting_id: null, cancel_requested_run: null, created_at: T, updated_at: T }]
    data.messages = [msg()]
    data.whiteboards = [wb()]
    data.cardBoards = [board()]
    const paths = buildExportEntries(data, { root: 'export' }).map((e) => e.path)
    expect(paths).toEqual([
      'export/README.md',
      'export/artifacts/Plan.md',
      'export/artifacts/Plan (2).md',
      'export/chats/2026-11-01 Hello.md',
      'export/whiteboards/Flow.excalidraw',
      'export/cards/Ideas.md',
      'export/links.md',
      'export/todos.md',
      'export/memories.md',
      'export/collections.md',
    ])
  })
  it('README counts reflect live artifacts only', () => {
    const data = empty()
    data.artifacts = [artifact(), artifact({ id: 'x', deleted_at: T })]
    const readme = buildExportEntries(data)[0].data as string
    expect(readme).toContain('| One markdown file per artifact | 1 |')
  })
})
