import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import {
  AgentIcon,
  ArtifactIcon,
  ChatIcon,
  CollectionIcon,
  CompassIcon,
  FileIcon,
  LinkIcon,
  SearchIcon,
  SkillIcon,
  TableIcon,
  TodoIcon,
  ToolIcon,
  WebhookIcon,
  type IconProps,
} from './icons'

// ---------------------------------------------------------------------------
// Global search (⌘K / Ctrl+K palette)
//
// Searches everything the signed-in user can see — RLS is the filter, so each
// query below returns only rows the caller is allowed to read. All sources are
// queried in parallel with a small per-source limit; there's no server-side
// search index, which is fine at intranet scale.
//
// Opening from anywhere: the component (mounted once in Layout) listens for a
// window event, so pages like Home can show their own search box and just call
// openGlobalSearch().
// ---------------------------------------------------------------------------

const OPEN_EVENT = 'global-search:open'

export function openGlobalSearch() {
  window.dispatchEvent(new Event(OPEN_EVENT))
}

export const isMac =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)

type Result = {
  key: string
  group: string
  title: string
  subtitle?: string
  to: string
  icon: (p: IconProps) => JSX.Element
}

// Pages the palette can jump to (mirrors the sidebar). Kept local so the
// palette works without threading Layout's nav config through props.
const PAGES: Array<{ label: string; to: string; keywords?: string; adminOnly?: boolean }> = [
  { label: 'Home', to: '/home', keywords: 'dashboard' },
  { label: 'Chat', to: '/chat', keywords: 'ai assistant conversation' },
  { label: 'Collections', to: '/collections' },
  { label: 'Files', to: '/files', keywords: 'upload storage pdf' },
  { label: 'Tables', to: '/tables', keywords: 'data spreadsheet' },
  { label: 'Artifacts', to: '/artifacts', keywords: 'documents docs' },
  { label: 'To-dos', to: '/todos', keywords: 'tasks todo' },
  { label: 'Links', to: '/links', keywords: 'bookmarks' },
  { label: 'Skills', to: '/skills', keywords: 'prompts' },
  { label: 'Agents', to: '/agents' },
  { label: 'Loops', to: '/loops' },
  { label: 'Tools', to: '/tools' },
  { label: 'Forge', to: '/forge', keywords: 'functions deploy', adminOnly: true },
  { label: 'Webhooks', to: '/webhooks' },
  { label: 'API', to: '/api', keywords: 'rest curl tokens' },
  { label: 'Activity', to: '/activity', keywords: 'log feed' },
  { label: 'Usage', to: '/usage', keywords: 'cost spend tokens', adminOnly: true },
  { label: 'Feedback', to: '/feedback', adminOnly: true },
  { label: 'Features', to: '/features', keywords: 'roadmap' },
  { label: 'Guardrails', to: '/guardrails', adminOnly: true },
  { label: 'Evals', to: '/evals', adminOnly: true },
  { label: 'Secrets', to: '/vault', keywords: 'vault keys', adminOnly: true },
  { label: 'Settings', to: '/settings', keywords: 'account email models invite' },
]

// Build a PostgREST `.or()` filter matching `q` against several columns.
// Patterns are double-quoted so commas/parens in the query can't break the
// filter grammar; quotes/backslashes are dropped from the needle, and %/_ are
// escaped so they match literally.
function orIlike(q: string, columns: string[]): string {
  const needle = q.replace(/["\\]/g, ' ').replace(/[%_]/g, '\\$&').trim()
  const pat = `"%${needle}%"`
  return columns.map((c) => `${c}.ilike.${pat}`).join(',')
}

const PER_SOURCE = 5

async function runSearch(q: string, isAdmin: boolean): Promise<Result[]> {
  const lower = q.toLowerCase()

  const pageResults: Result[] = PAGES.filter(
    (p) =>
      (!p.adminOnly || isAdmin) &&
      (p.label.toLowerCase().includes(lower) || p.keywords?.includes(lower)),
  )
    .slice(0, PER_SOURCE)
    .map((p) => ({
      key: `page:${p.to}`,
      group: 'Pages',
      title: p.label,
      subtitle: p.to,
      to: p.to,
      icon: CompassIcon,
    }))

  // Every source is independent; run them all at once and tolerate individual
  // failures (a missing table or RLS denial just contributes nothing).
  const [conversations, artifacts, collections, todos, links, files, tables, agents, skills, tools, webhooks] =
    await Promise.all([
      supabase
        .from('conversations')
        .select('id, title, updated_at')
        .ilike('title', `%${q.replace(/[%_]/g, '\\$&')}%`)
        .order('updated_at', { ascending: false })
        .limit(PER_SOURCE),
      supabase
        .from('artifacts')
        .select('id, title, type, updated_at')
        .or(orIlike(q, ['title', 'content']))
        .order('updated_at', { ascending: false })
        .limit(PER_SOURCE),
      supabase
        .from('collections')
        .select('id, name, description')
        .or(orIlike(q, ['name', 'description']))
        .limit(PER_SOURCE),
      supabase
        .from('todos')
        .select('id, title, done')
        .or(orIlike(q, ['title', 'notes']))
        .limit(PER_SOURCE),
      supabase
        .from('links')
        .select('id, title, url')
        .or(orIlike(q, ['title', 'url', 'description', 'notes']))
        .limit(PER_SOURCE),
      supabase
        .from('files')
        .select('id, name, mime_type')
        .ilike('name', `%${q.replace(/[%_]/g, '\\$&')}%`)
        .order('created_at', { ascending: false })
        .limit(PER_SOURCE),
      supabase
        .from('user_tables')
        .select('id, name, description')
        .or(orIlike(q, ['name', 'description']))
        .limit(PER_SOURCE),
      supabase
        .from('agents')
        .select('id, name, description')
        .or(orIlike(q, ['name', 'description']))
        .limit(PER_SOURCE),
      supabase
        .from('skills')
        .select('id, name, description')
        .or(orIlike(q, ['name', 'description']))
        .limit(PER_SOURCE),
      supabase
        .from('tools')
        .select('id, name, description')
        .or(orIlike(q, ['name', 'description']))
        .limit(PER_SOURCE),
      supabase
        .from('webhooks')
        .select('id, name')
        .ilike('name', `%${q.replace(/[%_]/g, '\\$&')}%`)
        .limit(PER_SOURCE),
    ])

  const out: Result[] = [...pageResults]

  for (const c of conversations.data ?? [])
    out.push({
      key: `conv:${c.id}`,
      group: 'Chats',
      title: c.title || 'Untitled chat',
      to: `/chat/${c.id}`,
      icon: ChatIcon,
    })
  for (const a of artifacts.data ?? [])
    out.push({
      key: `art:${a.id}`,
      group: 'Artifacts',
      title: a.title,
      subtitle: a.type,
      to: `/artifacts/${a.id}`,
      icon: ArtifactIcon,
    })
  for (const c of collections.data ?? [])
    out.push({
      key: `col:${c.id}`,
      group: 'Collections',
      title: c.name,
      subtitle: c.description || undefined,
      to: '/collections',
      icon: CollectionIcon,
    })
  for (const t of todos.data ?? [])
    out.push({
      key: `todo:${t.id}`,
      group: 'To-dos',
      title: t.title,
      subtitle: t.done ? 'done' : undefined,
      to: `/todos/${t.id}`,
      icon: TodoIcon,
    })
  for (const l of links.data ?? [])
    out.push({
      key: `link:${l.id}`,
      group: 'Links',
      title: l.title || l.url,
      subtitle: l.title ? l.url : undefined,
      to: '/links',
      icon: LinkIcon,
    })
  for (const f of files.data ?? [])
    out.push({
      key: `file:${f.id}`,
      group: 'Files',
      title: f.name,
      subtitle: f.mime_type ?? undefined,
      to: '/files',
      icon: FileIcon,
    })
  for (const t of tables.data ?? [])
    out.push({
      key: `table:${t.id}`,
      group: 'Tables',
      title: t.name,
      subtitle: t.description || undefined,
      to: '/tables',
      icon: TableIcon,
    })
  for (const a of agents.data ?? [])
    out.push({
      key: `agent:${a.id}`,
      group: 'Agents',
      title: a.name,
      subtitle: a.description || undefined,
      to: '/agents',
      icon: AgentIcon,
    })
  for (const s of skills.data ?? [])
    out.push({
      key: `skill:${s.id}`,
      group: 'Skills',
      title: s.name,
      subtitle: s.description ?? undefined,
      to: '/skills',
      icon: SkillIcon,
    })
  for (const t of tools.data ?? [])
    out.push({
      key: `tool:${t.id}`,
      group: 'Tools',
      title: t.name,
      subtitle: t.description || undefined,
      to: '/tools',
      icon: ToolIcon,
    })
  for (const w of webhooks.data ?? [])
    out.push({
      key: `wh:${w.id}`,
      group: 'Webhooks',
      title: w.name,
      to: '/webhooks',
      icon: WebhookIcon,
    })

  return out
}

export function GlobalSearch({ isAdmin }: { isAdmin: boolean }) {
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<Result[]>([])
  const [loading, setLoading] = useState(false)
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const requestId = useRef(0)

  const close = useCallback(() => {
    setOpen(false)
    setQuery('')
    setResults([])
    setActive(0)
  }, [])

  // Open via ⌘K / Ctrl+K anywhere, or the window event (sidebar/home buttons).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setOpen((v) => !v)
      }
    }
    const onOpen = () => setOpen(true)
    window.addEventListener('keydown', onKey)
    window.addEventListener(OPEN_EVENT, onOpen)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener(OPEN_EVENT, onOpen)
    }
  }, [])

  useEffect(() => {
    if (open) inputRef.current?.focus()
  }, [open])

  // Debounced fan-out; a stale response never overwrites a newer one.
  useEffect(() => {
    if (!open) return
    const q = query.trim()
    if (q.length < 2) {
      setResults([])
      setLoading(false)
      return
    }
    setLoading(true)
    const id = ++requestId.current
    const t = setTimeout(() => {
      runSearch(q, isAdmin)
        .then((r) => {
          if (requestId.current !== id) return
          setResults(r)
          setActive(0)
        })
        .catch(() => undefined)
        .finally(() => {
          if (requestId.current === id) setLoading(false)
        })
    }, 220)
    return () => clearTimeout(t)
  }, [open, query, isAdmin])

  const grouped = useMemo(() => {
    const map = new Map<string, Result[]>()
    for (const r of results) {
      const list = map.get(r.group) ?? []
      list.push(r)
      map.set(r.group, list)
    }
    return [...map.entries()]
  }, [results])

  const go = useCallback(
    (r: Result) => {
      close()
      navigate(r.to)
    },
    [close, navigate],
  )

  const onInputKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      close()
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((i) => Math.min(i + 1, results.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter' && results[active]) {
      e.preventDefault()
      go(results[active])
    }
  }

  // Keep the active row visible while arrowing through results.
  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [active])

  if (!open) return null

  let flatIndex = -1

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-slate-900/50 px-4 pt-[12vh]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close()
      }}
    >
      <div className="flex w-full max-w-[620px] flex-col overflow-hidden rounded-[18px] border border-border bg-surface shadow-soft-lg">
        <div className="flex items-center gap-3 border-b border-border px-5 py-4">
          <SearchIcon className="h-5 w-5 shrink-0 text-faint" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onInputKey}
            placeholder="Search chats, artifacts, files, to-dos, links, agents…"
            className="min-w-0 flex-1 bg-transparent text-[15px] text-text outline-none placeholder:text-faint"
          />
          <kbd className="rounded-md border border-border bg-surface-2 px-1.5 py-0.5 text-[11px] font-semibold text-faint">
            esc
          </kbd>
        </div>

        <div ref={listRef} className="max-h-[52vh] overflow-y-auto p-2">
          {query.trim().length < 2 ? (
            <div className="px-4 py-8 text-center text-sm text-faint">
              Type at least 2 characters to search everything you can see —
              chats, artifacts, collections, to-dos, links, files, tables,
              agents, skills, tools and webhooks.
            </div>
          ) : loading && results.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-faint">Searching…</div>
          ) : results.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-faint">
              No matches for “{query.trim()}”
            </div>
          ) : (
            grouped.map(([group, items]) => (
              <div key={group} className="mb-1">
                <div className="px-3 pb-1 pt-2 text-[11px] font-bold uppercase tracking-wider text-faint">
                  {group}
                </div>
                {items.map((r) => {
                  flatIndex += 1
                  const i = flatIndex
                  const Icon = r.icon
                  return (
                    <button
                      key={r.key}
                      data-index={i}
                      onClick={() => go(r)}
                      onMouseMove={() => setActive(i)}
                      className={`flex w-full items-center gap-3 rounded-[11px] px-3 py-2.5 text-left transition ${
                        i === active ? 'bg-primary-soft text-primary' : 'text-text hover:bg-surface-hover'
                      }`}
                    >
                      <Icon className="h-[18px] w-[18px] shrink-0" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-semibold">{r.title}</span>
                        {r.subtitle && (
                          <span
                            className={`block truncate text-xs ${
                              i === active ? 'text-primary/70' : 'text-faint'
                            }`}
                          >
                            {r.subtitle}
                          </span>
                        )}
                      </span>
                    </button>
                  )
                })}
              </div>
            ))
          )}
        </div>

        <div className="flex items-center gap-4 border-t border-border px-5 py-2.5 text-[11px] font-medium text-faint">
          <span>↑↓ navigate</span>
          <span>↵ open</span>
          <span className="ml-auto">{loading && results.length > 0 ? 'Updating…' : ''}</span>
        </div>
      </div>
    </div>
  )
}
