// Shared collection-context builder. Turns one or more collections into a single
// text block (artifacts + files + tables + links + to-dos) that gets injected as
// primary context.
// Lives here — not in the chat function — so ALL agent loops can use it: chat,
// webhook, and scheduler all inject an agent's bound collections the same way.
//
// Runs with the service role, so it RE-ENFORCES access in code: each collection
// must be visible to the caller (owner / workspace / admin) and only items the
// caller could read (own or non-private) are included. Items shared across the
// selected collections are DEDUPED, and the large items (artifacts + files) are
// budgeted to the model's real context window so the meter matches what's sent.

import { sceneToText } from './whiteboard_scene.ts'
import { cardsToText } from './card_board.ts'

const CHARS_PER_TOKEN = 4

// Cache OpenRouter's model catalog on the (warm) instance so we can budget the
// injected content against the live model's real context window.
let MODEL_CTX: Map<string, number> | null = null
async function modelContextLength(slug: string): Promise<number | null> {
  try {
    if (!MODEL_CTX) {
      const res = await fetch('https://openrouter.ai/api/v1/models')
      const json = await res.json()
      MODEL_CTX = new Map()
      for (const m of json?.data ?? []) {
        MODEL_CTX.set(String(m.id).toLowerCase(), Number(m?.context_length ?? 0))
      }
    }
    const s = (slug || '').toLowerCase()
    let v = MODEL_CTX.get(s)
    if (!v) {
      for (const [id, c] of MODEL_CTX) {
        if (id === s || id.endsWith(`/${s}`)) {
          v = c
          break
        }
      }
    }
    return v && v > 0 ? v : null
  } catch {
    return null
  }
}

export async function loadCollectionsContext(
  // deno-lint-ignore no-explicit-any
  db: any,
  collectionIds: string[],
  userId: string | null,
  model: string,
): Promise<string> {
  if (!db || !userId || !collectionIds.length) return ''
  try {
    const { data: cols } = await db
      .from('collections')
      .select('id, name, owner_id, visibility')
      .in('id', collectionIds)
    if (!cols?.length) return ''

    // Resolve admin once only if some collection isn't owner/workspace-visible.
    const needAdmin = (cols as Array<{ owner_id: string; visibility: string }>).some(
      (c) => c.owner_id !== userId && c.visibility !== 'workspace',
    )
    let isAdmin = false
    if (needAdmin) {
      const { data: prof } = await db.from('profiles').select('is_admin').eq('id', userId).maybeSingle()
      isAdmin = Boolean(prof?.is_admin)
    }
    const visible = (cols as Array<{ id: string; name: string; owner_id: string; visibility: string }>).filter(
      (c) => c.owner_id === userId || c.visibility === 'workspace' || isAdmin,
    )
    if (!visible.length) return ''
    const visibleIds = visible.map((c) => c.id)
    const names = visible.map((c) => c.name)

    const { data: links } = await db
      .from('collection_artifacts')
      .select('artifact_id')
      .in('collection_id', visibleIds)
    const ids = [...new Set((links ?? []).map((l: { artifact_id: string }) => l.artifact_id))]

    let readable: Array<{ title: string; type: string; content: string }> = []
    if (ids.length) {
      const { data: arts } = await db
        .from('artifacts')
        .select('id, title, type, content, visibility, owner_id')
        .in('id', ids)
        .is('deleted_at', null)
        .order('updated_at', { ascending: false })
      readable = (arts ?? []).filter(
        (a: { owner_id: string; visibility: string }) => a.owner_id === userId || a.visibility !== 'private',
      ) as Array<{ title: string; type: string; content: string }>
    }

    // Files — text files inlined, PDFs via their indexed knowledge text;
    // images/binaries skipped. Budgeted like artifacts.
    const { data: fileLinks } = await db
      .from('collection_files')
      .select('file_id')
      .in('collection_id', visibleIds)
    const fileIds = [...new Set((fileLinks ?? []).map((l: { file_id: string }) => l.file_id))]
    const fileDocs: Array<{ label: string; body: string }> = []
    if (fileIds.length) {
      const { data: files } = await db
        .from('files')
        .select('id, name, mime_type, bucket, path, owner_id, visibility')
        .in('id', fileIds)
      for (const f of (files ?? []).filter(
        (f: { owner_id: string; visibility: string }) => f.owner_id === userId || f.visibility !== 'private',
      ) as Array<{ id: string; name: string; mime_type: string | null; bucket: string | null; path: string }>) {
        const text = await fileToText(db, f, userId)
        if (text) fileDocs.push({ label: `## ${f.name} (file)`, body: text })
      }
    }

    // Tables — a preview of each user table's rows, injected as JSON text.
    // Re-enforce user_tables access (own or workspace-shared) in code.
    const { data: tableLinks } = await db
      .from('collection_tables')
      .select('table_id')
      .in('collection_id', visibleIds)
    const tableIds = [...new Set((tableLinks ?? []).map((l: { table_id: string }) => l.table_id))]
    const tableDocs: Array<{ label: string; body: string }> = []
    if (tableIds.length) {
      const { data: uts } = await db
        .from('user_tables')
        .select('id, name, physical_name, owner_id, visibility')
        .in('id', tableIds)
      for (const t of (uts ?? []).filter(
        (t: { owner_id: string; visibility: string }) => t.owner_id === userId || t.visibility === 'workspace',
      ) as Array<{ name: string; physical_name: string }>) {
        try {
          const { data: rows } = await db.from(t.physical_name).select('*').limit(50)
          if (rows && rows.length) {
            tableDocs.push({ label: `## ${t.name} (table — ${rows.length} row(s))`, body: JSON.stringify(rows, null, 2) })
          }
        } catch {
          // skip an unreadable table
        }
      }
    }

    // Links — small (title + url + description), so no budgeting needed.
    const { data: linkRows } = await db
      .from('collection_links')
      .select('link_id')
      .in('collection_id', visibleIds)
    const linkIds = [...new Set((linkRows ?? []).map((l: { link_id: string }) => l.link_id))]
    let webLinks: Array<{ title: string; url: string; description: string }> = []
    if (linkIds.length) {
      const { data: ls } = await db
        .from('links')
        .select('title, url, description, notes, owner_id, visibility')
        .in('id', linkIds)
        .order('created_at', { ascending: false })
      webLinks = ((ls ?? []) as Array<{ owner_id: string; visibility: string; title: string; url: string; description: string; notes: string }>)
        .filter((l) => l.owner_id === userId || l.visibility === 'workspace')
        .map((l) => ({ title: l.title, url: l.url, description: [l.description, l.notes].filter(Boolean).join(' — ') }))
    }

    // Agents — small (name + description); a compact directory of the agents
    // filed into the collection. Agents are a shared workspace catalogue, so any
    // member (the caller) may see them.
    const { data: agentRows } = await db
      .from('collection_agents')
      .select('agent_id')
      .in('collection_id', visibleIds)
    const agentIds = [...new Set((agentRows ?? []).map((l: { agent_id: string }) => l.agent_id))]
    let agents: Array<{ name: string; description: string }> = []
    if (agentIds.length) {
      const { data: ag } = await db
        .from('agents')
        .select('name, description')
        .in('id', agentIds)
        .order('name', { ascending: true })
      agents = ((ag ?? []) as Array<{ name: string; description: string }>).map((a) => ({
        name: a.name,
        description: a.description ?? '',
      }))
    }

    // To-dos — small (title + due + done), so no budgeting needed.
    const { data: todoLinks } = await db
      .from('collection_todos')
      .select('todo_id')
      .in('collection_id', visibleIds)
    const todoIds = [...new Set((todoLinks ?? []).map((l: { todo_id: string }) => l.todo_id))]
    let todos: Array<{ title: string; due_date: string | null; done: boolean }> = []
    if (todoIds.length) {
      const { data: t } = await db
        .from('todos')
        .select('title, due_date, done, owner_id, visibility')
        .in('id', todoIds)
        .order('done', { ascending: true })
        .order('due_date', { ascending: true, nullsFirst: false })
      todos = (t ?? []).filter(
        (td: { owner_id: string; visibility: string }) => td.owner_id === userId || td.visibility === 'workspace',
      ) as Array<{ title: string; due_date: string | null; done: boolean }>
    }

    // Whiteboards — the Excalidraw scene rendered to text (labels/shapes/arrows)
    // so a board is chattable. Budgeted like artifacts (a big board can be large).
    const { data: wbLinks } = await db
      .from('collection_whiteboards')
      .select('whiteboard_id')
      .in('collection_id', visibleIds)
    const wbIds = [...new Set((wbLinks ?? []).map((l: { whiteboard_id: string }) => l.whiteboard_id))]
    let whiteboards: Array<{ title: string; text: string }> = []
    if (wbIds.length) {
      const { data: wbs } = await db
        .from('whiteboards')
        .select('id, title, scene, owner_id, visibility')
        .in('id', wbIds)
        .order('updated_at', { ascending: false })
      whiteboards = ((wbs ?? []) as Array<{ owner_id: string; visibility: string; title: string; scene: unknown }>)
        .filter((w) => w.owner_id === userId || w.visibility !== 'private')
        .map((w) => ({ title: w.title, text: sceneToText(w.scene) }))
    }

    // Card boards — the cards rendered as a prioritized list. Small; injected as
    // a compact block (no budgeting) alongside links/todos.
    const { data: cbLinks } = await db
      .from('collection_card_boards')
      .select('card_board_id')
      .in('collection_id', visibleIds)
    const cbIds = [...new Set((cbLinks ?? []).map((l: { card_board_id: string }) => l.card_board_id))]
    let cardBoards: Array<{ title: string; text: string }> = []
    if (cbIds.length) {
      const { data: cbs } = await db
        .from('card_boards')
        .select('id, title, cards, owner_id, visibility')
        .in('id', cbIds)
        .order('updated_at', { ascending: false })
      cardBoards = ((cbs ?? []) as Array<{ owner_id: string; visibility: string; title: string; cards: unknown }>)
        .filter((c) => c.owner_id === userId || c.visibility !== 'private')
        .map((c) => ({ title: c.title, text: cardsToText({ cards: c.cards }) }))
    }

    if (
      !readable.length && !todos.length && !fileDocs.length && !tableDocs.length &&
      !webLinks.length && !agents.length && !whiteboards.length && !cardBoards.length
    ) return ''

    const parts: string[] = []

    const budgeted: Array<{ label: string; body: string }> = [
      ...readable.map((a) => ({ label: `## ${a.title} (${a.type})`, body: a.content ?? '' })),
      ...fileDocs,
      ...tableDocs,
      ...whiteboards.map((w) => ({ label: `## ${w.title} (whiteboard)`, body: w.text })),
    ]
    if (budgeted.length) {
      const ctxLen = await modelContextLength(model)
      const reserveTokens = ctxLen ? Math.min(Math.max(Math.floor(ctxLen * 0.2), 8000), 32000) : 16000
      const budgetTokens = ctxLen ? Math.max(ctxLen - reserveTokens, 8000) : 50000
      const totalChars = budgetTokens * CHARS_PER_TOKEN

      let total = 0
      let omitted = 0
      for (const d of budgeted) {
        const remaining = totalChars - total
        if (remaining <= 0) {
          omitted = budgeted.length - parts.length
          break
        }
        let body = (d.body ?? '').slice(0, remaining)
        if ((d.body ?? '').length > body.length) body += '\n…(truncated to fit the context window)'
        total += body.length
        parts.push(`${d.label}\n${body}`)
      }
      if (omitted) {
        parts.push(`…(${omitted} more item(s) omitted — the selection exceeds this model's context window.)`)
      }
    }

    if (webLinks.length) {
      const lines = webLinks
        .map((l) => `- ${l.title}: ${l.url}${l.description ? ` — ${l.description.slice(0, 300)}` : ''}`)
        .join('\n')
      parts.push(`## Links in this collection\n${lines}`)
    }

    if (agents.length) {
      const lines = agents
        .map((a) => `- ${a.name}${a.description ? `: ${a.description.slice(0, 300)}` : ''}`)
        .join('\n')
      parts.push(`## Agents in this collection\n${lines}`)
    }

    if (todos.length) {
      const lines = todos
        .map((t) => `- [${t.done ? 'x' : ' '}] ${t.title}${t.due_date ? ` (due ${t.due_date})` : ''}`)
        .join('\n')
      parts.push(`## To-dos in this collection\n${lines}`)
    }

    for (const cb of cardBoards) {
      parts.push(`## ${cb.title} (card board)\n${cb.text}`)
    }

    const itemCount =
      readable.length + fileDocs.length + tableDocs.length + todos.length + webLinks.length + agents.length +
      whiteboards.length + cardBoards.length
    const label =
      names.length === 1 ? `the "${names[0]}" collection` : `${names.length} collections (${names.map((n) => `"${n}"`).join(', ')})`
    return (
      `# Collection context: ${names.map((n) => `"${n}"`).join(', ')}\n` +
      `Scoped to ${label} — ${itemCount} item(s) total. ` +
      `Treat the following as the primary reference content; ground your answers in it.\n\n` +
      parts.join('\n\n---\n\n')
    )
  } catch {
    return ''
  }
}

// Turn a collection file into injectable text: an indexed PDF/doc → its
// extracted knowledge text (chunks, scope re-enforced); a text-like file →
// its decoded contents; anything else (images, binaries) → null (skipped).
async function fileToText(
  // deno-lint-ignore no-explicit-any
  db: any,
  f: { id: string; name: string; mime_type: string | null; bucket: string | null; path: string },
  userId: string,
): Promise<string | null> {
  const mime = (f.mime_type ?? '').toLowerCase()
  const MAX = 60000
  try {
    if (mime.includes('pdf') || /\.pdf$/i.test(f.name)) {
      const { data: doc } = await db
        .from('documents')
        .select('id, owner_id, scope, status')
        .eq('file_id', f.id)
        .maybeSingle()
      if (!doc) return '(PDF not indexed yet — its text isn’t available.)'
      if (doc.owner_id !== userId && doc.scope !== 'workspace') return null // not allowed
      const { data: chunks } = await db
        .from('document_chunks')
        .select('content')
        .eq('document_id', doc.id)
        .limit(400)
      const text = (chunks ?? []).map((c: { content: string }) => c.content).join('\n').slice(0, MAX)
      return text || (doc.status === 'done' ? '(no extractable text)' : '(PDF still being indexed.)')
    }
    const textLike =
      mime.startsWith('text/') ||
      ['application/json', 'application/xml', 'application/csv', 'text/csv'].includes(mime) ||
      /\.(md|markdown|txt|csv|tsv|json|ya?ml|log|html?|xml)$/i.test(f.name)
    if (textLike) {
      const { data: blob } = await db.storage.from(f.bucket ?? 'files').download(f.path)
      if (!blob) return null
      const buf = new Uint8Array(await blob.arrayBuffer())
      if (buf.byteLength > 4_000_000) return '(file too large to include inline)'
      return new TextDecoder().decode(buf).slice(0, MAX)
    }
    return null // image / unsupported binary — not injectable as text
  } catch {
    return null
  }
}
