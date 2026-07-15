import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import { supabase } from '../lib/supabase'
import { isMac, openGlobalSearch } from '../components/GlobalSearch'
import {
  activityFamily,
  bucketByDay,
  completionPct,
  timeAgo,
  type DayBucket,
} from '../lib/dashboard'
import {
  ActivityIcon,
  AgentIcon,
  ArrowRightIcon,
  ArtifactIcon,
  ChatIcon,
  CheckIcon,
  FileIcon,
  ForgeIcon,
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

const TREND_DAYS = 14

// ── Data shapes the dashboard renders ──────────────────────────────────────
type ActivityRow = { id: string; type: string; summary: string; created_at: string }
type TodoRow = { id: string; title: string; due_date: string | null; done: boolean }

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
  const [trendRows, setTrendRows] = useState<ActivityRow[]>([])
  const [feed, setFeed] = useState<ActivityRow[]>([])
  const [todos, setTodos] = useState<TodoRow[]>([])
  const [loading, setLoading] = useState(true)

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

  // Load everything the Overview needs in parallel. Counts use head-only
  // queries; the trend pulls just timestamps for the last TREND_DAYS.
  useEffect(() => {
    if (!user) return
    let alive = true
    const sinceTrend = new Date()
    sinceTrend.setDate(sinceTrend.getDate() - (TREND_DAYS - 1))
    sinceTrend.setHours(0, 0, 0, 0)
    const sinceWeek = new Date()
    sinceWeek.setDate(sinceWeek.getDate() - 7)

    const head = { count: 'exact' as const, head: true }
    Promise.all([
      supabase.from('todos').select('id', head).eq('done', false),
      supabase.from('todos').select('id', head).eq('done', true),
      supabase.from('artifacts').select('id', head),
      supabase.from('files').select('id', head),
      supabase.from('activity_log').select('id', head).gte('created_at', sinceWeek.toISOString()),
      supabase
        .from('activity_log')
        .select('id, type, summary, created_at')
        .gte('created_at', sinceTrend.toISOString())
        .order('created_at', { ascending: false })
        .limit(1000),
      supabase
        .from('todos')
        .select('id, title, due_date, done')
        .eq('done', false)
        .order('position', { ascending: true })
        .order('created_at', { ascending: false })
        .limit(6),
    ]).then(([oTodos, dTodos, arts, fls, wk, trend, td]) => {
      if (!alive) return
      setStats({
        todosOpen: oTodos.count ?? 0,
        todosDone: dTodos.count ?? 0,
        artifacts: arts.count ?? 0,
        files: fls.count ?? 0,
        weekEvents: wk.count ?? 0,
      })
      const rows = (trend.data ?? []) as ActivityRow[]
      setTrendRows(rows)
      setFeed(rows.slice(0, 7))
      setTodos((td.data ?? []) as TodoRow[])
      setLoading(false)
    })
    return () => {
      alive = false
    }
  }, [user])

  // Live feed: prepend new activity rows as they land (mirrors ActivityPage).
  useEffect(() => {
    const channel = supabase
      .channel('home_activity')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'activity_log' },
        (payload) => {
          const row = payload.new as ActivityRow
          setFeed((prev) => (prev.some((r) => r.id === row.id) ? prev : [row, ...prev].slice(0, 7)))
          setTrendRows((prev) => [row, ...prev])
          setStats((prev) => (prev ? { ...prev, weekEvents: prev.weekEvents + 1 } : prev))
        },
      )
      .subscribe()
    return () => {
      supabase.removeChannel(channel)
    }
  }, [])

  const buckets = useMemo(() => bucketByDay(trendRows, TREND_DAYS), [trendRows])
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
          <Overview
            loading={loading}
            stats={stats}
            pct={pct}
            buckets={buckets}
            feed={feed}
            todos={todos}
            navigate={navigate}
            quick={quick}
            onComplete={completeTodo}
          />
        ) : (
          <Explore cards={cards} quick={quick} navigate={navigate} />
        )}
      </div>
    </div>
  )
}

// ── Overview tab ────────────────────────────────────────────────────────────
function Overview({
  loading,
  stats,
  pct,
  buckets,
  feed,
  todos,
  navigate,
  quick,
  onComplete,
}: {
  loading: boolean
  stats: Stats | null
  pct: number
  buckets: DayBucket[]
  feed: ActivityRow[]
  todos: TodoRow[]
  navigate: (to: string) => void
  quick: string
  onComplete: (id: string) => void
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
      </div>

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

      {/* Activity trend chart */}
      <TrendChart buckets={buckets} loading={loading} />

      {/* Feed + to-dos */}
      <div className="mt-6 grid grid-cols-1 gap-[18px] lg:grid-cols-2">
        <ActivityFeed feed={feed} loading={loading} />
        <TodoList todos={todos} loading={loading} onComplete={onComplete} />
      </div>
    </>
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

function TrendChart({ buckets, loading }: { buckets: DayBucket[]; loading: boolean }) {
  const max = Math.max(1, ...buckets.map((b) => b.count))
  const total = buckets.reduce((s, b) => s + b.count, 0)
  return (
    <div className="rounded-[18px] border border-border bg-surface p-6 shadow-soft">
      <div className="mb-5 flex items-end justify-between">
        <div>
          <div className="text-[13px] font-bold uppercase tracking-[0.08em] text-faint">Activity</div>
          <div className="mt-1 text-[15px] font-semibold text-text">Last {buckets.length} days</div>
        </div>
        <div className="text-right">
          <div className="text-[26px] font-extrabold leading-none tracking-tight text-text">{total}</div>
          <div className="mt-1 text-[11px] font-semibold text-faint">events</div>
        </div>
      </div>
      {loading ? (
        <div className="h-[120px] animate-pulse rounded-xl bg-surface-2" />
      ) : (
        <div className="flex h-[120px] items-end gap-[3px] sm:gap-1.5">
          {buckets.map((b, i) => {
            const h = b.count === 0 ? 3 : Math.max(6, Math.round((b.count / max) * 112))
            const first = i === 0
            const last = i === buckets.length - 1
            return (
              <div key={b.key} className="group relative flex flex-1 flex-col items-center justify-end">
                <div
                  title={`${b.count} event${b.count === 1 ? '' : 's'}`}
                  className={`w-full rounded-t-[5px] transition-all ${
                    b.count === 0 ? 'bg-surface-2' : 'bg-primary/80 group-hover:bg-primary'
                  }`}
                  style={{ height: `${h}px` }}
                />
                {(first || last || i === Math.floor(buckets.length / 2)) && (
                  <span className="mt-1.5 text-[10px] font-medium text-faint">{b.label}</span>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function ActivityFeed({ feed, loading }: { feed: ActivityRow[]; loading: boolean }) {
  return (
    <div className="rounded-[18px] border border-border bg-surface p-6 shadow-soft">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-[15px] font-bold tracking-tight text-text">Recent activity</h2>
        <Link to="/activity" className="flex items-center gap-1 text-[13px] font-semibold text-primary hover:underline">
          View all <ArrowRightIcon className="h-3.5 w-3.5" />
        </Link>
      </div>
      {loading ? (
        <div className="space-y-3">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-9 animate-pulse rounded-lg bg-surface-2" />
          ))}
        </div>
      ) : feed.length === 0 ? (
        <div className="py-8 text-center text-sm text-faint">
          <ActivityIcon className="mx-auto mb-2 h-7 w-7 opacity-60" />
          Nothing yet — activity shows up here as it happens.
        </div>
      ) : (
        <ol className="space-y-1">
          {feed.map((ev) => {
            const fam = activityFamily(ev.type)
            return (
              <li key={ev.id} className="flex items-center gap-3 rounded-xl px-2 py-2 transition hover:bg-surface-2">
                <span className={`h-2 w-2 shrink-0 rounded-full ${fam.dot}`} />
                <span className="min-w-0 flex-1 truncate text-sm text-text">{ev.summary || fam.label}</span>
                <span className="shrink-0 text-[12px] font-medium text-faint">{timeAgo(ev.created_at)}</span>
              </li>
            )
          })}
        </ol>
      )}
    </div>
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
