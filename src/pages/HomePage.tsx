import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import { supabase } from '../lib/supabase'
import { formatDate } from '../lib/util'
import { isMac, openGlobalSearch } from '../components/GlobalSearch'
import { DashboardWidget } from '../components/DashboardWidget'
import { AddWidgetPanel } from '../components/AddWidgetPanel'
import type { Database } from '../lib/database.types'
import { completionPct } from '../lib/dashboard'
import { normalizeUrl } from '../lib/linkEdit'
import {
  ActivityIcon,
  AgentIcon,
  ArrowRightIcon,
  ArtifactIcon,
  ChatIcon,
  CheckIcon,
  CloseIcon,
  FileIcon,
  ForgeIcon,
  GlobeIcon,
  LinkIcon,
  LockIcon,
  PinIcon,
  PlusIcon,
  PulseIcon,
  SearchIcon,
  SettingsIcon,
  ShieldIcon,
  SkillIcon,
  SparkleIcon,
  TodoIcon,
  ToolIcon,
  UploadIcon,
  UsageIcon,
  UsersIcon,
  WebhookIcon,
  type IconProps,
} from '../components/icons'

type Card = {
  to: string
  title: string
  desc: string
  icon: (p: IconProps) => JSX.Element
  adminOnly?: boolean
}

const CARDS: Card[] = [
  { to: '/chat', title: 'Chat', icon: ChatIcon, desc: 'Chat with your AI — bring in your tools, skills and uploaded files, and work alongside teammates in a shared thread.' },
  { to: '/agents', title: 'Agents', icon: AgentIcon, desc: 'Processes that run on a schedule — every few minutes, hourly or daily — with the tools and skills they need to get the job done on their own.' },
  { to: '/artifacts', title: 'Artifacts', icon: ArtifactIcon, desc: 'As your team builds items and documents, save them all here and share any one of them with a hosted link.' },
  { to: '/skills', title: 'Skills', icon: SkillIcon, desc: 'Organize the documents that teach the AI how your team likes work done, and update them whenever things change.' },
  { to: '/tools', title: 'Tools', icon: ToolIcon, desc: 'Capabilities the AI can call to get work done. A handful come built in — and you’ll find plenty more that are easy to make.' },
  { to: '/forge', title: 'Forge', icon: ForgeIcon, adminOnly: true, desc: 'Build the more complex, deterministic functions the AI can lean on. A calculator is the classic example: exact math beats a guess.' },
  { to: '/guardrails', title: 'Guardrails', icon: ShieldIcon, adminOnly: true, desc: 'Put guardrails in place for your business that keep certain prompts and behaviors from ever running.' },
  { to: '/webhooks', title: 'Webhooks', icon: WebhookIcon, desc: 'Take in information from other systems like an API or an event, then have an agent react to it automatically.' },
  { to: '/activity', title: 'Activity', icon: ActivityIcon, desc: 'See everything happening across your system — built for logging and troubleshooting.' },
  { to: '/usage', title: 'Usage', icon: UsageIcon, adminOnly: true, desc: 'Track the tokens being spent and the models in use, with cost insights pulled straight from OpenRouter.' },
  { to: '/files', title: 'Files', icon: FileIcon, desc: 'Every uploaded file and its indexing status — soon usable across chats so your team can build shared context.' },
  { to: '/settings', title: 'Settings', icon: SettingsIcon, desc: 'Set up your email, your OpenRouter connection for AI, and the rest of your account details.' },
]

function greetingForNow(): string {
  const hr = new Date().getHours()
  return hr < 12 ? 'Good morning' : hr < 18 ? 'Good afternoon' : 'Good evening'
}

// ── Data shapes the dashboard renders ──────────────────────────────────────
type TodoRow = { id: string; title: string; due_date: string | null; done: boolean }
type WidgetRow = Database['public']['Tables']['dashboard_widgets']['Row']
type ArtifactRow = Database['public']['Tables']['artifacts']['Row']

type Stats = {
  todosOpen: number
  todosDone: number
  artifacts: number
  files: number
  weekEvents: number
}

// A date is "overdue" when it's strictly before today (local) and still open.
function isOverdue(due: string | null): boolean {
  if (!due) return false
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  return new Date(due + 'T00:00:00').getTime() < today.getTime()
}

function shortDue(due: string): string {
  return new Date(due + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export default function HomePage() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const [isAdmin, setIsAdmin] = useState(false)
  const [name, setName] = useState('')
  const [tab, setTab] = useState<'overview' | 'explore'>('overview')

  // Dashboard data
  const [stats, setStats] = useState<Stats | null>(null)
  const [todos, setTodos] = useState<TodoRow[]>([])
  const [pinnedArtifacts, setPinnedArtifacts] = useState<ArtifactRow[]>([])
  const [loading, setLoading] = useState(true)

  // Custom widgets (owner-only rows; realtime so AI-added ones pop in live)
  const [widgets, setWidgets] = useState<WidgetRow[]>([])
  const [addOpen, setAddOpen] = useState(false)

  // Quick todo modal
  const [showTodoModal, setShowTodoModal] = useState(false)

  // Quick link modal
  const [showLinkModal, setShowLinkModal] = useState(false)

  useEffect(() => {
    if (!user) return
    supabase
      .from('profiles')
      .select('is_admin, display_name')
      .eq('id', user.id)
      .maybeSingle()
      .then(({ data }) => {
        setIsAdmin(Boolean(data?.is_admin))
        const fallback = (user.email ?? '').split('@')[0]
        const raw = (data?.display_name || fallback || '').trim()
        setName(raw ? raw.charAt(0).toUpperCase() + raw.slice(1) : '')
      })
  }, [user])

  // Load everything the Overview needs in parallel. Counts use head-only queries.
  useEffect(() => {
    if (!user) return
    let alive = true
    const sinceWeek = new Date()
    sinceWeek.setDate(sinceWeek.getDate() - 7)

    const head = { count: 'exact' as const, head: true }
    Promise.all([
      supabase.from('todos').select('id', head).eq('done', false),
      supabase.from('todos').select('id', head).eq('done', true),
      supabase.from('artifacts').select('id', head).is('deleted_at', null),
      supabase.from('files').select('id', head),
      supabase.from('activity_log').select('id', head).gte('created_at', sinceWeek.toISOString()),
      supabase
        .from('todos')
        .select('id, title, due_date, done')
        .eq('done', false)
        .order('position', { ascending: true })
        .order('created_at', { ascending: false })
        .limit(6),
      supabase
        .from('artifacts')
        .select('*')
        .eq('pinned', true)
        .is('deleted_at', null)
        .order('updated_at', { ascending: false })
        .limit(12),
    ]).then(([oTodos, dTodos, arts, fls, wk, td, pinned]) => {
      if (!alive) return
      setStats({
        todosOpen: oTodos.count ?? 0,
        todosDone: dTodos.count ?? 0,
        artifacts: arts.count ?? 0,
        files: fls.count ?? 0,
        weekEvents: wk.count ?? 0,
      })
      setTodos((td.data ?? []) as TodoRow[])
      setPinnedArtifacts((pinned.data ?? []) as ArtifactRow[])
      setLoading(false)
    })
    return () => {
      alive = false
    }
  }, [user])

  // Live activity: update stats as new activity rows land.
  useEffect(() => {
    const channel = supabase
      .channel('home_activity')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'activity_log' },
        () => {
          setStats((prev) => (prev ? { ...prev, weekEvents: prev.weekEvents + 1 } : prev))
        },
      )
      .subscribe()
    return () => {
      supabase.removeChannel(channel)
    }
  }, [])

  // Subscribe to pinned artifacts changes
  useEffect(() => {
    if (!user) return
    const channel = supabase
      .channel('home_pinned_artifacts')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'artifacts', filter: `owner_id=eq.${user.id}` },
        (payload) => {
          if (payload.eventType === 'UPDATE' || payload.eventType === 'INSERT') {
            const row = payload.new as ArtifactRow
            if (row.pinned) {
              setPinnedArtifacts((prev) => {
                const filtered = prev.filter((a) => a.id !== row.id)
                return [row, ...filtered].slice(0, 12)
              })
            } else {
              setPinnedArtifacts((prev) => prev.filter((a) => a.id !== row.id))
            }
          } else if (payload.eventType === 'DELETE') {
            const old = payload.old as { id: string }
            setPinnedArtifacts((prev) => prev.filter((a) => a.id !== old.id))
          }
        },
      )
      .subscribe()
    return () => {
      supabase.removeChannel(channel)
    }
  }, [user])

  // Load the user's widgets + subscribe: a widget the AI adds in chat (or on
  // another device) appears here live; removals/edits sync too.
  useEffect(() => {
    if (!user) return
    let alive = true
    supabase
      .from('dashboard_widgets')
      .select('*')
      .order('position', { ascending: true })
      .order('created_at', { ascending: true })
      .then(({ data }) => {
        if (alive) setWidgets((data ?? []) as WidgetRow[])
      })
    const channel = supabase
      .channel('home_widgets')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'dashboard_widgets', filter: `owner_id=eq.${user.id}` },
        (payload) => {
          if (payload.eventType === 'INSERT') {
            const row = payload.new as WidgetRow
            setWidgets((prev) => (prev.some((w) => w.id === row.id) ? prev : [...prev, row]))
          } else if (payload.eventType === 'DELETE') {
            const old = payload.old as { id: string }
            setWidgets((prev) => prev.filter((w) => w.id !== old.id))
          } else {
            const row = payload.new as WidgetRow
            setWidgets((prev) => prev.map((w) => (w.id === row.id ? row : w)))
          }
        },
      )
      .subscribe()
    return () => {
      alive = false
      supabase.removeChannel(channel)
    }
  }, [user])

  const removeWidget = async (id: string) => {
    setWidgets((prev) => prev.filter((w) => w.id !== id))
    await supabase.from('dashboard_widgets').delete().eq('id', id)
  }

  const addQuickTodo = async (title: string) => {
    if (!user) return
    const { data, error } = await supabase
      .from('todos')
      .insert({ owner_id: user.id, title, position: 0, visibility: 'private' })
      .select('id, title, due_date, done')
      .single()

    if (!error && data) {
      setTodos((prev) => [data as TodoRow, ...prev.slice(0, 5)])
      setStats((prev) => (prev ? { ...prev, todosOpen: prev.todosOpen + 1 } : prev))
      setShowTodoModal(false)
    }
  }

  const addQuickLink = async (rawUrl: string) => {
    if (!user) return null
    const url = normalizeUrl(rawUrl)
    if (!url) return null

    // Extract hostname as temporary title
    const hostOf = (u: string): string => {
      try {
        return new URL(u).hostname.replace(/^www\./, '')
      } catch {
        return u
      }
    }

    const { data, error } = await supabase
      .from('links')
      .insert({ owner_id: user.id, url, title: hostOf(url), visibility: 'private' })
      .select('*')
      .single()

    if (!error && data) {
      setShowLinkModal(false)
      return data
    }
    return null
  }

  const pct = completionPct(stats?.todosDone ?? 0, (stats?.todosOpen ?? 0) + (stats?.todosDone ?? 0))

  const cards = CARDS.filter((c) => !c.adminOnly || isAdmin)

  const completeTodo = async (id: string) => {
    setTodos((prev) => prev.filter((t) => t.id !== id))
    setStats((prev) =>
      prev ? { ...prev, todosOpen: Math.max(0, prev.todosOpen - 1), todosDone: prev.todosDone + 1 } : prev,
    )
    await supabase
      .from('todos')
      .update({ done: true, completed_at: new Date().toISOString() })
      .eq('id', id)
  }

  const quick = 'flex items-center gap-2 rounded-2xl px-5 py-3 text-[15px] font-bold transition'

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[1140px] px-6 py-12 sm:px-11">
        <div className="mb-6">
          <div className="text-[13px] font-bold uppercase tracking-[0.14em] text-faint">
            Team overview
          </div>
          <h1 className="mt-2 text-[34px] font-extrabold tracking-tight text-text">
            {greetingForNow()}{name ? `, ${name}` : ''}.
          </h1>
          <p className="mt-3 max-w-xl text-[17px] leading-relaxed text-muted">
            Here’s what’s been happening across your workspace.
          </p>
        </div>

        {/* Tab switch: the live dashboard vs. the full feature index */}
        <div className="mb-8 inline-flex rounded-2xl border border-border bg-surface-2 p-1">
          {(['overview', 'explore'] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`rounded-xl px-4 py-1.5 text-sm font-bold capitalize transition ${
                tab === t ? 'bg-surface text-text shadow-soft' : 'text-muted hover:text-text'
              }`}
            >
              {t === 'overview' ? 'Overview' : 'Explore'}
            </button>
          ))}
        </div>

        {tab === 'overview' ? (
          <>
            <Overview
              loading={loading}
              stats={stats}
              pct={pct}
              todos={todos}
              pinnedArtifacts={pinnedArtifacts}
              navigate={navigate}
              quick={quick}
              onComplete={completeTodo}
              onOpenTodoModal={() => setShowTodoModal(true)}
              onOpenLinkModal={() => setShowLinkModal(true)}
            />
            <WidgetsSection
              widgets={widgets}
              addOpen={addOpen}
              onToggleAdd={() => setAddOpen((v) => !v)}
              onCloseAdd={() => setAddOpen(false)}
              onRemove={removeWidget}
            />
          </>
        ) : (
          <Explore cards={cards} quick={quick} navigate={navigate} />
        )}
      </div>

      {/* Quick todo modal */}
      {showTodoModal && (
        <QuickTodoModal
          onClose={() => setShowTodoModal(false)}
          onSave={addQuickTodo}
        />
      )}

      {/* Quick link modal */}
      {showLinkModal && (
        <QuickLinkModal
          onClose={() => setShowLinkModal(false)}
          onSave={addQuickLink}
        />
      )}
    </div>
  )
}

// ── Overview tab ────────────────────────────────────────────────────────────
function Overview({
  loading,
  stats,
  pct,
  todos,
  pinnedArtifacts,
  navigate,
  quick,
  onComplete,
  onOpenTodoModal,
  onOpenLinkModal,
}: {
  loading: boolean
  stats: Stats | null
  pct: number
  todos: TodoRow[]
  pinnedArtifacts: ArtifactRow[]
  navigate: (to: string) => void
  quick: string
  onComplete: (id: string) => void
  onOpenTodoModal: () => void
  onOpenLinkModal: () => void
}) {
  return (
    <>
      {/* Quick actions */}
      <div className="mb-8 flex flex-wrap gap-3">
        <button
          onClick={() => navigate('/chat')}
          className={`${quick} border-none bg-primary text-white shadow-soft hover:bg-primary-strong`}
        >
          <SparkleIcon className="h-[18px] w-[18px]" /> Start a chat
        </button>
        <button
          onClick={() => navigate('/files')}
          className={`${quick} border border-border bg-surface text-text hover:border-primary hover:text-primary`}
        >
          <UploadIcon className="h-[18px] w-[18px]" /> Upload a file
        </button>
        <button
          onClick={() => navigate('/agents')}
          className={`${quick} border border-border bg-surface text-text hover:border-primary hover:text-primary`}
        >
          <AgentIcon className="h-[18px] w-[18px]" /> New agent
        </button>
        <button
          onClick={onOpenTodoModal}
          className={`${quick} border border-border bg-surface text-text hover:border-primary hover:text-primary`}
        >
          <TodoIcon className="h-[18px] w-[18px]" /> New todo
        </button>
        <button
          onClick={onOpenLinkModal}
          className={`${quick} border border-border bg-surface text-text hover:border-primary hover:text-primary`}
        >
          <LinkIcon className="h-[18px] w-[18px]" /> New link
        </button>
      </div>

      {/* Pinned artifacts */}
      {pinnedArtifacts.length > 0 && (
        <PinnedArtifacts artifacts={pinnedArtifacts} loading={loading} navigate={navigate} />
      )}

      {/* Stat tiles */}
      <div className="mb-6 grid grid-cols-2 gap-[18px] lg:grid-cols-4">
        <StatTile
          to="/todos"
          label="Open to-dos"
          value={stats?.todosOpen}
          loading={loading}
          icon={TodoIcon}
          accent="text-teal-500"
          footer={
            <div className="mt-3">
              <div className="flex items-center justify-between text-[11px] font-semibold text-faint">
                <span>{pct}% complete</span>
                <span>{stats?.todosDone ?? 0} done</span>
              </div>
              <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-surface-2">
                <div
                  className="h-full rounded-full bg-teal-500 transition-all"
                  style={{ width: `${pct}%` }}
                />
              </div>
            </div>
          }
        />
        <StatTile to="/artifacts" label="Artifacts" value={stats?.artifacts} loading={loading} icon={ArtifactIcon} accent="text-emerald-500" />
        <StatTile to="/files" label="Files" value={stats?.files} loading={loading} icon={FileIcon} accent="text-sky-500" />
        <StatTile
          to="/activity"
          label="Events this week"
          value={stats?.weekEvents}
          loading={loading}
          icon={PulseIcon}
          accent="text-primary"
          footer={<div className="mt-3 text-[11px] font-semibold text-faint">Last 7 days of activity</div>}
        />
      </div>

      {/* To-dos */}
      <div className="mt-6">
        <TodoList todos={todos} loading={loading} onComplete={onComplete} />
      </div>
    </>
  )
}

// Custom, user-composable widgets. Additive to the built-in overview above —
// the AI (or the "Add widget" prompt) writes DB rows the dashboard renders.
function WidgetsSection({
  widgets,
  addOpen,
  onToggleAdd,
  onCloseAdd,
  onRemove,
}: {
  widgets: WidgetRow[]
  addOpen: boolean
  onToggleAdd: () => void
  onCloseAdd: () => void
  onRemove: (id: string) => void
}) {
  return (
    <div className="mt-10">
      <div className="mb-4 flex items-center justify-between">
        <div className="text-[13px] font-bold uppercase tracking-[0.08em] text-faint">Your widgets</div>
        <button
          onClick={onToggleAdd}
          className="flex items-center gap-1.5 rounded-xl border border-border bg-surface px-3 py-1.5 text-[13px] font-bold text-text transition hover:border-primary hover:text-primary"
        >
          <PlusIcon className="h-4 w-4" /> Add widget
        </button>
      </div>

      {addOpen && (
        <div className="mb-[18px]">
          <AddWidgetPanel onClose={onCloseAdd} />
        </div>
      )}

      {widgets.length === 0 ? (
        !addOpen && (
          <button
            onClick={onToggleAdd}
            className="flex w-full flex-col items-center justify-center rounded-[18px] border border-dashed border-border-strong bg-surface px-6 py-12 text-center transition hover:border-primary"
          >
            <span className="mb-3 flex h-11 w-11 items-center justify-center rounded-[13px] bg-primary-soft text-primary">
              <PlusIcon className="h-[22px] w-[22px]" />
            </span>
            <div className="text-[15px] font-bold text-text">Build your own dashboard</div>
            <div className="mt-1 max-w-sm text-sm text-muted">
              Add counts, lists, or charts of your to-dos, artifacts, files, links, collections, or
              activity — just describe what you want to see.
            </div>
          </button>
        )
      ) : (
        <div className="grid grid-cols-1 gap-[18px] sm:grid-cols-2 lg:grid-cols-3">
          {widgets.map((w) => (
            <DashboardWidget key={w.id} widget={w} onRemove={onRemove} />
          ))}
        </div>
      )}
    </div>
  )
}

function StatTile({
  to,
  label,
  value,
  loading,
  icon: Icon,
  accent,
  footer,
}: {
  to: string
  label: string
  value: number | undefined
  loading: boolean
  icon: (p: IconProps) => JSX.Element
  accent: string
  footer?: JSX.Element
}) {
  return (
    <Link
      to={to}
      className="group flex flex-col rounded-[18px] border border-border bg-surface p-5 shadow-soft transition hover:-translate-y-[2px] hover:border-border-strong hover:shadow-soft-lg"
    >
      <div className="flex items-center justify-between">
        <span className="text-[12px] font-bold uppercase tracking-[0.06em] text-faint">{label}</span>
        <Icon className={`h-[18px] w-[18px] ${accent}`} />
      </div>
      <div className="mt-2 text-[34px] font-extrabold leading-none tracking-tight text-text">
        {loading || value === undefined ? <span className="text-faint">—</span> : value.toLocaleString()}
      </div>
      {footer}
    </Link>
  )
}

function TodoList({
  todos,
  loading,
  onComplete,
}: {
  todos: TodoRow[]
  loading: boolean
  onComplete: (id: string) => void
}) {
  return (
    <div className="rounded-[18px] border border-border bg-surface p-6 shadow-soft">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-[15px] font-bold tracking-tight text-text">Your to-dos</h2>
        <Link to="/todos" className="flex items-center gap-1 text-[13px] font-semibold text-primary hover:underline">
          View all <ArrowRightIcon className="h-3.5 w-3.5" />
        </Link>
      </div>
      {loading ? (
        <div className="space-y-3">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-9 animate-pulse rounded-lg bg-surface-2" />
          ))}
        </div>
      ) : todos.length === 0 ? (
        <div className="py-8 text-center text-sm text-faint">
          <TodoIcon className="mx-auto mb-2 h-7 w-7 opacity-60" />
          All clear — no open to-dos.
        </div>
      ) : (
        <ul className="space-y-1">
          {todos.map((t) => {
            const overdue = isOverdue(t.due_date)
            return (
              <li key={t.id} className="flex items-center gap-3 rounded-xl px-2 py-2 transition hover:bg-surface-2">
                <button
                  onClick={() => onComplete(t.id)}
                  title="Mark done"
                  className="group flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 border-border-strong text-transparent transition hover:border-teal-500 hover:text-teal-500"
                >
                  <CheckIcon className="h-3 w-3" />
                </button>
                <span className="min-w-0 flex-1 truncate text-sm text-text">{t.title}</span>
                {t.due_date && (
                  <span
                    className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                      overdue ? 'bg-red-500/15 text-red-500' : 'bg-primary-soft text-primary'
                    }`}
                  >
                    {shortDue(t.due_date)}
                  </span>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

function PinnedArtifacts({
  artifacts,
  loading,
  navigate,
}: {
  artifacts: ArtifactRow[]
  loading: boolean
  navigate: (to: string) => void
}) {
  const VIS_ICON = { private: LockIcon, workspace: UsersIcon, unlisted: LinkIcon, public: GlobeIcon }

  return (
    <div className="mb-6">
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <PinIcon className="h-4 w-4 text-primary" />
          <h2 className="text-[15px] font-bold tracking-tight text-text">Pinned artifacts</h2>
        </div>
        <Link to="/artifacts" className="flex items-center gap-1 text-[13px] font-semibold text-primary hover:underline">
          View all <ArrowRightIcon className="h-3.5 w-3.5" />
        </Link>
      </div>
      {loading ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-28 animate-pulse rounded-xl bg-surface-2" />
          ))}
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {artifacts.map((a) => {
            const VisIcon = VIS_ICON[a.visibility]
            return (
              <button
                key={a.id}
                onClick={() => navigate(`/artifacts/${a.id}`)}
                className="group rounded-xl border border-border bg-surface p-4 text-left shadow-soft transition hover:-translate-y-[2px] hover:border-border-strong hover:shadow-soft-lg"
              >
                <div className="flex items-start justify-between">
                  <h3 className="truncate font-medium text-text group-hover:text-primary">{a.title}</h3>
                  <VisIcon className="h-4 w-4 shrink-0 text-faint" />
                </div>
                <p className="mt-1 line-clamp-2 text-xs text-muted">
                  {a.content.replace(/[#*`>]/g, '').slice(0, 120) || 'Empty'}
                </p>
                <p className="mt-3 text-[11px] uppercase tracking-wide text-faint">
                  {a.type} · {formatDate(a.updated_at)}
                </p>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ── Explore tab (the original feature index) ────────────────────────────────
function Explore({
  cards,
  quick,
  navigate,
}: {
  cards: Card[]
  quick: string
  navigate: (to: string) => void
}) {
  return (
    <>
      <button
        onClick={openGlobalSearch}
        className="mb-6 flex w-full max-w-xl items-center gap-3 rounded-2xl border border-border bg-surface px-5 py-[14px] text-left text-[15px] text-faint shadow-soft transition hover:border-primary hover:text-muted"
      >
        <SearchIcon className="h-5 w-5 shrink-0" />
        <span className="flex-1">Search chats, artifacts, files, to-dos, links, agents…</span>
        <kbd className="rounded-md border border-border bg-surface-2 px-2 py-1 text-[11px] font-semibold">
          {isMac ? '⌘K' : 'Ctrl K'}
        </kbd>
      </button>

      <div className="mb-8 flex flex-wrap gap-3">
        <button
          onClick={() => navigate('/chat')}
          className={`${quick} border-none bg-primary text-white shadow-soft hover:bg-primary-strong`}
        >
          <SparkleIcon className="h-[18px] w-[18px]" /> Start a chat
        </button>
        <button
          onClick={() => navigate('/agents')}
          className={`${quick} border border-border bg-surface text-text hover:border-primary hover:text-primary`}
        >
          <AgentIcon className="h-[18px] w-[18px]" /> New agent
        </button>
      </div>

      <div className="mb-4 text-[13px] font-bold uppercase tracking-[0.08em] text-faint">
        Explore your workspace
      </div>
      <div className="grid grid-cols-1 gap-[18px] sm:grid-cols-2 lg:grid-cols-3">
        {cards.map((c) => {
          const Icon = c.icon
          return (
            <Link
              key={c.to}
              to={c.to}
              className="group flex flex-col items-start rounded-[18px] border border-border bg-surface p-[22px] text-left shadow-soft transition hover:-translate-y-[3px] hover:border-border-strong hover:shadow-soft-lg"
            >
              <div className="mb-4 flex w-full items-center justify-between">
                <div className="flex h-11 w-11 items-center justify-center rounded-[13px] bg-primary-soft text-primary">
                  <Icon className="h-[22px] w-[22px]" />
                </div>
                <span className="text-faint transition group-hover:text-primary">
                  <ArrowRightIcon className="h-[18px] w-[18px]" />
                </span>
              </div>
              <div className="mb-[7px] text-[18px] font-bold tracking-tight text-text">{c.title}</div>
              <div className="text-sm leading-relaxed text-muted">{c.desc}</div>
            </Link>
          )
        })}
      </div>
    </>
  )
}

// ── Quick Todo Modal ────────────────────────────────────────────────────────
function QuickTodoModal({ onClose, onSave }: { onClose: () => void; onSave: (title: string) => Promise<void> }) {
  const [title, setTitle] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  async function handleSave() {
    const trimmed = title.trim()
    if (!trimmed || saving) return
    setSaving(true)
    try {
      await onSave(trimmed)
      setTitle('')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center p-4" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative flex w-full max-w-md flex-col rounded-2xl border border-border bg-surface shadow-2xl">
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <div className="flex items-center gap-2">
            <TodoIcon className="h-5 w-5 text-primary" />
            <h3 className="text-base font-semibold text-text">Quick add to-do</h3>
          </div>
          <button onClick={onClose} className="rounded-md p-1.5 text-faint hover:bg-surface-hover hover:text-text" aria-label="Close">
            <CloseIcon className="h-4 w-4" />
          </button>
        </div>

        <div className="px-5 py-4">
          <label className="mb-2 block text-sm font-medium text-text">Title</label>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                handleSave()
              }
            }}
            placeholder="What needs to be done?"
            autoFocus
            className="w-full rounded-lg border border-border-strong bg-surface px-3 py-2.5 text-sm outline-none focus:border-primary focus:ring-1 focus:ring-primary-soft"
          />
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-3">
          <button
            onClick={onClose}
            className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-text hover:bg-surface-hover"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={!title.trim() || saving}
            className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm font-semibold text-white hover:bg-primary-strong disabled:opacity-50"
          >
            <PlusIcon className="h-4 w-4" /> {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Quick Link Modal ────────────────────────────────────────────────────────
function QuickLinkModal({ onClose, onSave }: { onClose: () => void; onSave: (url: string) => Promise<unknown> }) {
  const [url, setUrl] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  async function handleSave() {
    const trimmed = url.trim()
    if (!trimmed || saving) return
    setSaving(true)
    setError('')
    try {
      const result = await onSave(trimmed)
      if (result) {
        setUrl('')
      } else {
        setError('Invalid URL. Please enter a valid web address.')
      }
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center p-4" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative flex w-full max-w-md flex-col rounded-2xl border border-border bg-surface shadow-2xl">
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <div className="flex items-center gap-2">
            <LinkIcon className="h-5 w-5 text-primary" />
            <h3 className="text-base font-semibold text-text">Quick add link</h3>
          </div>
          <button onClick={onClose} className="rounded-md p-1.5 text-faint hover:bg-surface-hover hover:text-text" aria-label="Close">
            <CloseIcon className="h-4 w-4" />
          </button>
        </div>

        <div className="px-5 py-4">
          <label className="mb-2 block text-sm font-medium text-text">URL</label>
          <input
            value={url}
            onChange={(e) => {
              setUrl(e.target.value)
              setError('')
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                handleSave()
              }
            }}
            placeholder="https://example.com or example.com"
            autoFocus
            className="w-full rounded-lg border border-border-strong bg-surface px-3 py-2.5 text-sm outline-none focus:border-primary focus:ring-1 focus:ring-primary-soft"
          />
          {error && <p className="mt-2 text-xs text-red-500">{error}</p>}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-3">
          <button
            onClick={onClose}
            className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-text hover:bg-surface-hover"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={!url.trim() || saving}
            className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm font-semibold text-white hover:bg-primary-strong disabled:opacity-50"
          >
            <PlusIcon className="h-4 w-4" /> {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}
