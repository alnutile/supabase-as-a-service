import { useState } from 'react'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../contexts/AuthContext'
import { createZip } from '../../lib/zip'
import {
  buildExportEntries,
  exportCounts,
  exportFolderName,
  type CollectionMembership,
  type ExportCounts,
  type ExportData,
} from '../../lib/workspaceExport'
import { SettingsShell } from './shell'

// Settings -> Export. Anyone can download everything they can see as a zip of
// plain files (markdown + Excalidraw), for migrating off the workspace or for
// handing to an AI as context. Everything is read with the user's own session,
// so RLS decides what's included - nothing here can widen access. The zip is
// built in the browser; no server function is involved.

const PAGE = 1000

type Page<T> = PromiseLike<{ data: T[] | null; error: { message: string } | null }>

/** PostgREST caps a response at ~1000 rows, so walk the range until it runs dry. */
async function fetchAll<T>(label: string, page: (from: number, to: number) => Page<T>): Promise<T[]> {
  const rows: T[] = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await page(from, from + PAGE - 1)
    if (error) throw new Error(`${label}: ${error.message}`)
    rows.push(...(data ?? []))
    if (!data || data.length < PAGE) return rows
  }
}

async function memberships(): Promise<CollectionMembership[]> {
  const [artifacts, links, todos, whiteboards, cardBoards] = await Promise.all([
    fetchAll('collection_artifacts', (f, t) =>
      supabase.from('collection_artifacts').select('collection_id, artifact_id').order('created_at').range(f, t),
    ),
    fetchAll('collection_links', (f, t) =>
      supabase.from('collection_links').select('collection_id, link_id').order('created_at').range(f, t),
    ),
    fetchAll('collection_todos', (f, t) =>
      supabase.from('collection_todos').select('collection_id, todo_id').order('created_at').range(f, t),
    ),
    fetchAll('collection_whiteboards', (f, t) =>
      supabase.from('collection_whiteboards').select('collection_id, whiteboard_id').order('created_at').range(f, t),
    ),
    fetchAll('collection_card_boards', (f, t) =>
      supabase.from('collection_card_boards').select('collection_id, card_board_id').order('created_at').range(f, t),
    ),
  ])
  return [
    ...artifacts.map((r) => ({ collection_id: r.collection_id, kind: 'artifact' as const, item_id: r.artifact_id })),
    ...links.map((r) => ({ collection_id: r.collection_id, kind: 'link' as const, item_id: r.link_id })),
    ...todos.map((r) => ({ collection_id: r.collection_id, kind: 'todo' as const, item_id: r.todo_id })),
    ...whiteboards.map((r) => ({ collection_id: r.collection_id, kind: 'whiteboard' as const, item_id: r.whiteboard_id })),
    ...cardBoards.map((r) => ({ collection_id: r.collection_id, kind: 'card_board' as const, item_id: r.card_board_id })),
  ]
}

async function loadExportData(onStep: (s: string) => void): Promise<ExportData> {
  onStep('Artifacts')
  const artifacts = await fetchAll('artifacts', (f, t) =>
    supabase.from('artifacts').select('*').is('deleted_at', null).order('created_at').range(f, t),
  )
  onStep('Chats')
  const conversations = await fetchAll('conversations', (f, t) =>
    supabase.from('conversations').select('*').order('created_at').range(f, t),
  )
  const messages = await fetchAll('messages', (f, t) =>
    supabase.from('messages').select('*').order('created_at').order('id').range(f, t),
  )
  onStep('Whiteboards and cards')
  const whiteboards = await fetchAll('whiteboards', (f, t) =>
    supabase.from('whiteboards').select('*').order('created_at').range(f, t),
  )
  const cardBoards = await fetchAll('card boards', (f, t) =>
    supabase.from('card_boards').select('*').order('created_at').range(f, t),
  )
  onStep('Links, to-dos and memory')
  const links = await fetchAll('links', (f, t) => supabase.from('links').select('*').order('created_at').range(f, t))
  const todos = await fetchAll('todos', (f, t) => supabase.from('todos').select('*').order('created_at').range(f, t))
  const memories = await fetchAll('memories', (f, t) =>
    supabase.from('user_memories').select('*').order('created_at').range(f, t),
  )
  onStep('Collections')
  const collections = await fetchAll('collections', (f, t) =>
    supabase.from('collections').select('*').order('created_at').range(f, t),
  )
  return {
    artifacts,
    conversations,
    messages,
    whiteboards,
    cardBoards,
    links,
    todos,
    memories,
    collections,
    memberships: await memberships(),
  }
}

/** Keep only rows the user owns (and the messages/memberships that hang off them). */
function onlyMine(d: ExportData, uid: string): ExportData {
  const mine = <T extends { owner_id: string }>(rows: T[]) => rows.filter((r) => r.owner_id === uid)
  const conversations = mine(d.conversations)
  const convIds = new Set(conversations.map((c) => c.id))
  const collections = mine(d.collections)
  const colIds = new Set(collections.map((c) => c.id))
  return {
    artifacts: mine(d.artifacts),
    conversations,
    messages: d.messages.filter((m) => convIds.has(m.conversation_id)),
    whiteboards: mine(d.whiteboards),
    cardBoards: mine(d.cardBoards),
    links: mine(d.links),
    todos: mine(d.todos),
    memories: mine(d.memories),
    collections,
    memberships: d.memberships.filter((m) => colIds.has(m.collection_id)),
  }
}

function download(bytes: Uint8Array, filename: string) {
  // createZip always allocates a plain ArrayBuffer (never shared), so this cast is safe.
  const blob = new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'application/zip' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

const COUNT_LABELS: [keyof ExportCounts, string][] = [
  ['artifacts', 'Artifacts'],
  ['chats', 'Chats'],
  ['whiteboards', 'Whiteboards'],
  ['cardBoards', 'Card boards'],
  ['links', 'Links'],
  ['todos', 'To-dos'],
  ['memories', 'Memories'],
  ['collections', 'Collections'],
]

export default function ExportSettings() {
  const { user } = useAuth()
  const [scope, setScope] = useState<'all' | 'mine'>('all')
  const [busy, setBusy] = useState(false)
  const [step, setStep] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<{ counts: ExportCounts; size: number } | null>(null)

  async function run() {
    if (!user || busy) return
    setBusy(true)
    setError(null)
    setDone(null)
    try {
      const all = await loadExportData(setStep)
      const data = scope === 'mine' ? onlyMine(all, user.id) : all
      setStep('Building zip')
      const now = new Date()
      const folder = exportFolderName(now)
      const zip = createZip(buildExportEntries(data, { exportedAt: now, scope, root: folder }))
      download(zip, `${folder}.zip`)
      setDone({ counts: exportCounts(data), size: zip.length })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
      setStep(null)
    }
  }

  return (
    <SettingsShell
      title="Export"
      subtitle="Download your workspace as a zip of plain files - for moving elsewhere or handing to an AI as context."
    >
      <div className="mt-6 space-y-5">
        <section className="rounded-xl border border-border bg-surface p-5">
          <h2 className="text-[11px] font-bold uppercase tracking-wider text-faint">What's inside</h2>
          <ul className="mt-3 space-y-1.5 text-sm text-muted">
            <li><span className="font-medium text-text">artifacts/</span> - one markdown file per artifact</li>
            <li><span className="font-medium text-text">chats/</span> - one markdown transcript per conversation</li>
            <li><span className="font-medium text-text">whiteboards/</span> - Excalidraw files (open at excalidraw.com)</li>
            <li><span className="font-medium text-text">cards/</span> - one markdown list per card board, in priority order</li>
            <li><span className="font-medium text-text">links.md, todos.md, memories.md, collections.md</span> - one file each</li>
          </ul>
          <p className="mt-3 text-xs text-faint">
            Files, tables and archived artifacts aren't included. Everything is read with your own access, so you only
            get what you can already see.
          </p>
        </section>

        <section className="rounded-xl border border-border bg-surface p-5">
          <h2 className="text-[11px] font-bold uppercase tracking-wider text-faint">Download</h2>
          <fieldset className="mt-3 space-y-2 text-sm" disabled={busy}>
            <label className="flex items-center gap-2 text-text">
              <input type="radio" name="scope" checked={scope === 'all'} onChange={() => setScope('all')} />
              Everything I can see <span className="text-xs text-faint">(includes items teammates shared)</span>
            </label>
            <label className="flex items-center gap-2 text-text">
              <input type="radio" name="scope" checked={scope === 'mine'} onChange={() => setScope('mine')} />
              Only items I own
            </label>
          </fieldset>
          <div className="mt-4 flex items-center gap-3">
            <button
              onClick={run}
              disabled={busy || !user}
              className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white transition hover:opacity-90 disabled:opacity-50"
            >
              {busy ? 'Exporting…' : 'Export to zip'}
            </button>
            {step && <span className="text-sm text-faint">{step}…</span>}
          </div>
          {error && <p className="mt-3 text-sm text-red-500">Export failed: {error}</p>}
          {done && (
            <div className="mt-4 border-t border-border pt-3 text-sm">
              <p className="text-text">
                Downloaded {(done.size / 1024 / 1024).toFixed(done.size < 1024 * 1024 ? 2 : 1)} MB.
              </p>
              <dl className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1 sm:grid-cols-4">
                {COUNT_LABELS.map(([k, label]) => (
                  <div key={k} className="flex justify-between gap-2">
                    <dt className="text-muted">{label}</dt>
                    <dd className="font-medium text-text">{done.counts[k]}</dd>
                  </div>
                ))}
              </dl>
            </div>
          )}
        </section>
      </div>
    </SettingsShell>
  )
}
