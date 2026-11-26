// Pure formatting for the workspace export (Settings -> Export).
//
// Turns the rows a user can see into a folder of plain files meant to be handed
// to an AI as context (or kept as a backup / migration):
//
//   README.md                  what's in the archive and how it's laid out
//   artifacts/<title>.md       one markdown file per artifact (front matter + body)
//   chats/<date>-<title>.md    one markdown transcript per conversation
//   whiteboards/<title>.excalidraw   opens in excalidraw.com / the VS Code plugin
//   cards/<title>.md           one markdown list per card board, in priority order
//   links.md                   every bookmark in one file
//   todos.md                   every to-do in one file, grouped by lane
//   memories.md                the user's saved memory profile
//   collections.md             which items sit in which collection
//
// No I/O here: ExportSettings fetches the rows (under RLS) and passes them in,
// so this module is unit-tested and the page stays thin.

import type { Database, Json } from './database.types'
import type { ZipEntry } from './zip'

type Tables = Database['public']['Tables']
export type ExportArtifact = Tables['artifacts']['Row']
export type ExportLink = Tables['links']['Row']
export type ExportConversation = Tables['conversations']['Row']
export type ExportMessage = Tables['messages']['Row']
export type ExportWhiteboard = Tables['whiteboards']['Row']
export type ExportCardBoard = Tables['card_boards']['Row']
export type ExportTodo = Tables['todos']['Row']
export type ExportMemory = Tables['user_memories']['Row']
export type ExportCollection = Tables['collections']['Row']

export type CollectionMembership = {
  collection_id: string
  kind: 'artifact' | 'link' | 'todo' | 'whiteboard' | 'card_board'
  item_id: string
}

export type ExportData = {
  artifacts: ExportArtifact[]
  links: ExportLink[]
  conversations: ExportConversation[]
  messages: ExportMessage[]
  whiteboards: ExportWhiteboard[]
  cardBoards: ExportCardBoard[]
  todos: ExportTodo[]
  memories: ExportMemory[]
  collections: ExportCollection[]
  memberships: CollectionMembership[]
}

/** Turn a title into a filesystem-safe file stem (keeps unicode letters). */
export function safeFileStem(title: string, fallback = 'untitled'): string {
  const stem = (title ?? '')
    .normalize('NFKC')
    // path separators, reserved Windows chars, control chars
    // eslint-disable-next-line no-control-regex
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .replace(/[. ]+$/, '')
    .slice(0, 80)
    .trim()
  return stem || fallback
}

/**
 * Hands out unique file paths inside one folder: a second "Notes.md" becomes
 * "Notes (2).md". Case-insensitive, because macOS/Windows filesystems are.
 */
export function uniquePathAllocator(): (folder: string, stem: string, ext: string) => string {
  const used = new Set<string>()
  return (folder, stem, ext) => {
    const prefix = folder ? `${folder}/` : ''
    let n = 1
    let path = `${prefix}${stem}${ext}`
    while (used.has(path.toLowerCase())) {
      n += 1
      path = `${prefix}${stem} (${n})${ext}`
    }
    used.add(path.toLowerCase())
    return path
  }
}

/** YAML front matter. Strings go through JSON.stringify, which is valid YAML. */
export function frontMatter(fields: Record<string, string | number | boolean | null | undefined | string[]>): string {
  const lines = ['---']
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null || v === '') continue
    if (Array.isArray(v)) {
      if (v.length === 0) continue
      lines.push(`${k}: [${v.map((s) => JSON.stringify(s)).join(', ')}]`)
    } else if (typeof v === 'string') {
      lines.push(`${k}: ${JSON.stringify(v)}`)
    } else {
      lines.push(`${k}: ${v}`)
    }
  }
  lines.push('---')
  return lines.join('\n')
}

/** A fence long enough that the body can't close it early. */
export function fence(body: string, lang = ''): string {
  const longest = Math.max(2, ...(body.match(/`{3,}/g) ?? []).map((m) => m.length))
  const ticks = '`'.repeat(longest + 1)
  return `${ticks}${lang}\n${body}\n${ticks}`
}

function day(iso: string | null | undefined): string {
  return iso ? iso.slice(0, 10) : ''
}

/** Collection names per item, for tagging files with where they're filed. */
export function collectionIndex(
  collections: ExportCollection[],
  memberships: CollectionMembership[],
): Map<string, string[]> {
  const names = new Map(collections.map((c) => [c.id, c.name]))
  const out = new Map<string, string[]>()
  for (const m of memberships) {
    const name = names.get(m.collection_id)
    if (!name) continue
    const key = `${m.kind}:${m.item_id}`
    const list = out.get(key) ?? []
    if (!list.includes(name)) list.push(name)
    out.set(key, list)
  }
  for (const list of out.values()) list.sort((a, b) => a.localeCompare(b))
  return out
}

export function artifactToMarkdown(a: ExportArtifact, collections: string[] = []): string {
  const head = frontMatter({
    title: a.title,
    type: a.type,
    language: a.language,
    visibility: a.visibility,
    collections,
    created: a.created_at,
    updated: a.updated_at,
    id: a.id,
  })
  const content = a.content ?? ''
  let body: string
  if (a.type === 'code') body = fence(content, a.language ?? '')
  else if (a.type === 'html') body = fence(content, 'html')
  else body = content
  return `${head}\n\n# ${a.title}\n\n${body.trim() ? body : '_(empty)_'}\n`
}

function roleLabel(role: string): string {
  if (role === 'user') return 'User'
  if (role === 'assistant') return 'Assistant'
  return role.charAt(0).toUpperCase() + role.slice(1)
}

function attachmentNames(attachments: Json | null): string[] {
  if (!Array.isArray(attachments)) return []
  return attachments
    .map((a) => (a && typeof a === 'object' && !Array.isArray(a) ? (a as Record<string, Json>).name : null))
    .filter((n): n is string => typeof n === 'string' && n.length > 0)
}

export function conversationToMarkdown(c: ExportConversation, messages: ExportMessage[]): string {
  const sorted = [...messages].sort((a, b) => a.created_at.localeCompare(b.created_at))
  const head = frontMatter({
    title: c.title,
    created: c.created_at,
    updated: c.updated_at,
    messages: sorted.length,
    id: c.id,
  })
  const parts = [`${head}\n\n# ${c.title || 'Untitled chat'}`]
  if (sorted.length === 0) parts.push('_(no messages)_')
  for (const m of sorted) {
    const files = attachmentNames(m.attachments)
    const attach = files.length ? `\n\n_Attachments: ${files.join(', ')}_` : ''
    parts.push(`## ${roleLabel(m.role)} - ${m.created_at.replace('T', ' ').slice(0, 16)}\n\n${(m.content ?? '').trim() || '_(empty)_'}${attach}`)
  }
  return parts.join('\n\n') + '\n'
}

/** An Excalidraw file (opens in excalidraw.com, Obsidian, the VS Code plugin). */
export function whiteboardToExcalidraw(w: ExportWhiteboard): string {
  const scene = (w.scene && typeof w.scene === 'object' && !Array.isArray(w.scene) ? w.scene : {}) as Record<string, Json>
  const appState = (scene.appState && typeof scene.appState === 'object' && !Array.isArray(scene.appState)
    ? { ...(scene.appState as Record<string, Json>) }
    : {}) as Record<string, Json>
  // Live-session state that means nothing in a file.
  delete appState.collaborators
  return JSON.stringify(
    {
      type: 'excalidraw',
      version: 2,
      source: 'supanet-export',
      elements: Array.isArray(scene.elements) ? scene.elements : [],
      appState,
      files: scene.files && typeof scene.files === 'object' && !Array.isArray(scene.files) ? scene.files : {},
    },
    null,
    2,
  )
}

type LooseCard = { text: string; color: string; x: number; y: number }

function looseCards(raw: Json): LooseCard[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((c): c is Record<string, Json> => !!c && typeof c === 'object' && !Array.isArray(c))
    .map((c) => ({
      text: typeof c.text === 'string' ? c.text : '',
      color: typeof c.color === 'string' ? c.color : '',
      x: typeof c.x === 'number' ? c.x : 0,
      y: typeof c.y === 'number' ? c.y : 0,
    }))
}

/** A card board as a prioritized list: position IS the ranking (top first, then left). */
export function cardBoardToMarkdown(b: ExportCardBoard, collections: string[] = []): string {
  const cards = looseCards(b.cards)
    .filter((c) => c.text.trim())
    .sort((a, z) => a.y - z.y || a.x - z.x)
  const head = frontMatter({
    title: b.title,
    visibility: b.visibility,
    collections,
    cards: cards.length,
    created: b.created_at,
    updated: b.updated_at,
    id: b.id,
  })
  const list = cards.length
    ? cards
        .map((c, i) => {
          const tag = c.color ? ` _(${c.color})_` : ''
          const text = c.text.trim().replace(/\n+/g, '\n   ')
          return `${i + 1}. ${text}${tag}`
        })
        .join('\n')
    : '_(no cards)_'
  return `${head}\n\n# ${b.title}\n\nCards in priority order (top of the board first).\n\n${list}\n`
}

export function linksToMarkdown(links: ExportLink[], index: Map<string, string[]> = new Map()): string {
  const sorted = [...links].sort((a, b) => b.created_at.localeCompare(a.created_at))
  const parts = [`# Links\n\n${sorted.length} saved link${sorted.length === 1 ? '' : 's'}, newest first.`]
  for (const l of sorted) {
    const lines = [`## [${(l.title || l.url).replace(/[[\]]/g, '')}](${l.url})`, '']
    if (l.description?.trim()) lines.push(l.description.trim(), '')
    if (l.notes?.trim()) lines.push(`Notes: ${l.notes.trim()}`, '')
    const meta = [`Saved ${day(l.created_at)}`]
    if (l.tags?.length) meta.push(`tags: ${l.tags.join(', ')}`)
    const cols = index.get(`link:${l.id}`)
    if (cols?.length) meta.push(`collections: ${cols.join(', ')}`)
    lines.push(`_${meta.join(' · ')}_`)
    parts.push(lines.join('\n'))
  }
  return parts.join('\n\n') + '\n'
}

const LANE_ORDER: Record<string, number> = { doing: 0, next: 1, blocked: 2, triage: 3, done: 4 }
const LANE_TITLE: Record<string, string> = {
  doing: 'Doing',
  next: 'Next',
  blocked: 'Blocked',
  triage: 'Triage',
  done: 'Done',
}

export function todosToMarkdown(todos: ExportTodo[], index: Map<string, string[]> = new Map()): string {
  const lane = (t: ExportTodo) => (t.done ? 'done' : t.status && t.status !== 'done' ? t.status : 'next')
  const groups = new Map<string, ExportTodo[]>()
  for (const t of todos) {
    const k = lane(t)
    groups.set(k, [...(groups.get(k) ?? []), t])
  }
  const open = todos.filter((t) => !t.done).length
  const parts = [`# To-dos\n\n${open} open, ${todos.length - open} done.`]
  const lanes = [...groups.keys()].sort((a, b) => (LANE_ORDER[a] ?? 9) - (LANE_ORDER[b] ?? 9))
  for (const k of lanes) {
    const items = groups.get(k)!.sort((a, b) => a.position - b.position || b.created_at.localeCompare(a.created_at))
    const lines = items.map((t) => {
      const meta: string[] = []
      if (t.due_date) meta.push(`due ${t.due_date}`)
      if (t.done && t.completed_at) meta.push(`completed ${day(t.completed_at)}`)
      if (t.visibility === 'workspace') meta.push('team')
      const cols = index.get(`todo:${t.id}`)
      if (cols?.length) meta.push(`collections: ${cols.join(', ')}`)
      const suffix = meta.length ? ` _(${meta.join(' · ')})_` : ''
      const notes = t.notes?.trim() ? `\n  ${t.notes.trim().replace(/\n/g, '\n  ')}` : ''
      return `- [${t.done ? 'x' : ' '}] ${t.title}${suffix}${notes}`
    })
    parts.push(`## ${LANE_TITLE[k] ?? k}\n\n${lines.join('\n')}`)
  }
  return parts.join('\n\n') + '\n'
}

export function memoriesToMarkdown(memories: ExportMemory[]): string {
  const byCat = new Map<string, ExportMemory[]>()
  for (const m of memories) {
    const k = m.category || 'general'
    byCat.set(k, [...(byCat.get(k) ?? []), m])
  }
  const parts = ['# Memory\n\nDurable facts and preferences the assistant remembers about me.']
  for (const cat of [...byCat.keys()].sort()) {
    const lines = byCat
      .get(cat)!
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.created_at.localeCompare(b.created_at))
      .map((m) => `- ${m.content.trim().replace(/\n/g, ' ')}${m.pinned ? ' _(pinned)_' : ''}`)
    parts.push(`## ${cat}\n\n${lines.join('\n')}`)
  }
  return parts.join('\n\n') + '\n'
}

export function collectionsToMarkdown(data: ExportData): string {
  const titles = new Map<string, string>()
  for (const a of data.artifacts) titles.set(`artifact:${a.id}`, a.title)
  for (const l of data.links) titles.set(`link:${l.id}`, l.title || l.url)
  for (const t of data.todos) titles.set(`todo:${t.id}`, t.title)
  for (const w of data.whiteboards) titles.set(`whiteboard:${w.id}`, w.title)
  for (const b of data.cardBoards) titles.set(`card_board:${b.id}`, b.title)
  const kindLabel: Record<CollectionMembership['kind'], string> = {
    artifact: 'Artifacts',
    link: 'Links',
    todo: 'To-dos',
    whiteboard: 'Whiteboards',
    card_board: 'Card boards',
  }
  const parts = ['# Collections\n\nNamed groups of items. Each item below also lives in its own file elsewhere in this export.']
  const sorted = [...data.collections].sort((a, b) => a.name.localeCompare(b.name))
  for (const c of sorted) {
    const lines = [`## ${c.name}`]
    if (c.description?.trim()) lines.push('', c.description.trim())
    const mine = data.memberships.filter((m) => m.collection_id === c.id)
    let any = false
    for (const kind of Object.keys(kindLabel) as CollectionMembership['kind'][]) {
      const items = mine
        .filter((m) => m.kind === kind)
        .map((m) => titles.get(`${kind}:${m.item_id}`))
        .filter((t): t is string => !!t)
        .sort((a, b) => a.localeCompare(b))
      if (!items.length) continue
      any = true
      lines.push('', `**${kindLabel[kind]}**`, '', ...items.map((t) => `- ${t}`))
    }
    if (!any) lines.push('', '_(empty)_')
    parts.push(lines.join('\n'))
  }
  return parts.join('\n\n') + '\n'
}

export type ExportCounts = {
  artifacts: number
  chats: number
  messages: number
  whiteboards: number
  cardBoards: number
  links: number
  todos: number
  memories: number
  collections: number
}

export function exportCounts(data: ExportData): ExportCounts {
  return {
    artifacts: data.artifacts.length,
    chats: data.conversations.length,
    messages: data.messages.length,
    whiteboards: data.whiteboards.length,
    cardBoards: data.cardBoards.length,
    links: data.links.length,
    todos: data.todos.length,
    memories: data.memories.length,
    collections: data.collections.length,
  }
}

export function readme(counts: ExportCounts, exportedAt: Date, scope: 'all' | 'mine'): string {
  return `# Workspace export

Exported ${exportedAt.toISOString()} (${scope === 'mine' ? 'only items I own' : 'everything I can see'}).

This archive is plain files meant to be read by people and handed to an AI as
context. Markdown files start with YAML front matter (title, dates, id).

| Path | What | Count |
| --- | --- | --- |
| \`artifacts/\` | One markdown file per artifact | ${counts.artifacts} |
| \`chats/\` | One markdown transcript per conversation | ${counts.chats} (${counts.messages} messages) |
| \`whiteboards/\` | Excalidraw files - open at excalidraw.com | ${counts.whiteboards} |
| \`cards/\` | One markdown list per card board, in priority order | ${counts.cardBoards} |
| \`links.md\` | Every saved link | ${counts.links} |
| \`todos.md\` | Every to-do, grouped by lane | ${counts.todos} |
| \`memories.md\` | What the assistant remembers about me | ${counts.memories} |
| \`collections.md\` | Which items are filed in which collection | ${counts.collections} |
`
}

/** Build every file in the archive. Archived (soft-deleted) artifacts are skipped. */
export function buildExportEntries(
  data: ExportData,
  opts: { exportedAt?: Date; scope?: 'all' | 'mine'; root?: string } = {},
): ZipEntry[] {
  const exportedAt = opts.exportedAt ?? new Date()
  const root = opts.root ? `${opts.root.replace(/\/+$/, '')}/` : ''
  const alloc = uniquePathAllocator()
  const index = collectionIndex(data.collections, data.memberships)
  const entries: ZipEntry[] = []
  const add = (path: string, content: string, iso?: string | null) =>
    entries.push({ path: root + path, data: content, date: iso ? new Date(iso) : exportedAt })

  const live = data.artifacts.filter((a) => !a.deleted_at)
  const filtered: ExportData = { ...data, artifacts: live }
  add('README.md', readme(exportCounts(filtered), exportedAt, opts.scope ?? 'all'))

  for (const a of [...live].sort((x, y) => x.title.localeCompare(y.title))) {
    add(alloc('artifacts', safeFileStem(a.title), '.md'), artifactToMarkdown(a, index.get(`artifact:${a.id}`)), a.updated_at)
  }

  const byConv = new Map<string, ExportMessage[]>()
  for (const m of data.messages) byConv.set(m.conversation_id, [...(byConv.get(m.conversation_id) ?? []), m])
  for (const c of [...data.conversations].sort((x, y) => x.created_at.localeCompare(y.created_at))) {
    const stem = `${day(c.created_at)} ${safeFileStem(c.title, 'untitled chat')}`
    add(alloc('chats', stem, '.md'), conversationToMarkdown(c, byConv.get(c.id) ?? []), c.updated_at)
  }

  for (const w of [...data.whiteboards].sort((x, y) => x.title.localeCompare(y.title))) {
    add(alloc('whiteboards', safeFileStem(w.title, 'untitled board'), '.excalidraw'), whiteboardToExcalidraw(w), w.updated_at)
  }

  for (const b of [...data.cardBoards].sort((x, y) => x.title.localeCompare(y.title))) {
    add(alloc('cards', safeFileStem(b.title, 'untitled board'), '.md'), cardBoardToMarkdown(b, index.get(`card_board:${b.id}`)), b.updated_at)
  }

  add('links.md', linksToMarkdown(data.links, index))
  add('todos.md', todosToMarkdown(data.todos, index))
  add('memories.md', memoriesToMarkdown(data.memories))
  add('collections.md', collectionsToMarkdown(filtered))
  return entries
}

/** e.g. "workspace-export-2026-11-26" */
export function exportFolderName(d: Date): string {
  return `workspace-export-${d.toISOString().slice(0, 10)}`
}
