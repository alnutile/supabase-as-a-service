import { useEffect, useState } from 'react'
import { NavLink, Outlet, useNavigate } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import { supabase } from '../lib/supabase'
import {
  ActivityIcon,
  AgentIcon,
  ApiIcon,
  ArtifactIcon,
  ChatIcon,
  ChevronDownIcon,
  CloseIcon,
  EvalIcon,
  FeedbackIcon,
  FileIcon,
  ForgeIcon,
  HomeIcon,
  LoopIcon,
  LogoutIcon,
  MenuIcon,
  MoonIcon,
  PluginIcon,
  SettingsIcon,
  ShieldIcon,
  SkillIcon,
  SparkleIcon,
  SunIcon,
  TableIcon,
  ToolIcon,
  UsageIcon,
  WebhookIcon,
} from './icons'

type NavItem = {
  to: string
  label: string
  icon: (p: { className?: string }) => JSX.Element
  end?: boolean
  adminOnly?: boolean
}

// The sidebar is organized into labeled, collapsible groups. Items at the top
// (Home, Chat) live in an unlabeled group that always shows. `Settings` is pinned
// to the bottom (rendered separately), matching the dashboard layout.
const navGroups: Array<{ label: string | null; items: NavItem[] }> = [
  {
    label: null,
    items: [
      { to: '/home', label: 'Home', icon: HomeIcon },
      { to: '/chat', label: 'Chat', icon: ChatIcon },
    ],
  },
  {
    label: 'Assets',
    items: [
      { to: '/files', label: 'Files', icon: FileIcon },
      { to: '/tables', label: 'Tables', icon: TableIcon },
      { to: '/artifacts', label: 'Artifacts', icon: ArtifactIcon },
      { to: '/skills', label: 'Skills', icon: SkillIcon },
    ],
  },
  {
    label: 'Automation',
    items: [
      { to: '/agents', label: 'Agents', icon: AgentIcon },
      { to: '/loops', label: 'Loops', icon: LoopIcon },
      { to: '/tools', label: 'Tools', icon: ToolIcon },
      { to: '/forge', label: 'Forge', icon: ForgeIcon, adminOnly: true },
    ],
  },
  {
    label: 'Connections',
    items: [
      { to: '/webhooks', label: 'Webhooks', icon: WebhookIcon },
      { to: '/api', label: 'API', icon: ApiIcon },
      { to: '/plugins', label: 'Plugins', icon: PluginIcon },
    ],
  },
  {
    label: 'Insights',
    items: [
      { to: '/activity', label: 'Activity', icon: ActivityIcon },
      { to: '/usage', label: 'Usage', icon: UsageIcon, adminOnly: true },
      { to: '/feedback', label: 'Feedback', icon: FeedbackIcon, adminOnly: true },
    ],
  },
  {
    label: 'Governance',
    items: [
      { to: '/guardrails', label: 'Guardrails', icon: ShieldIcon, adminOnly: true },
      { to: '/evals', label: 'Evals', icon: EvalIcon, adminOnly: true },
    ],
  },
]

const settingsItem: NavItem = { to: '/settings', label: 'Settings', icon: SettingsIcon }

// Persist which groups the user has collapsed, so it sticks across reloads.
function useCollapsedGroups(): [Set<string>, (label: string) => void] {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem('nav.collapsed')
      return new Set<string>(raw ? JSON.parse(raw) : [])
    } catch {
      return new Set<string>()
    }
  })
  const toggle = (label: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(label)) next.delete(label)
      else next.add(label)
      try {
        localStorage.setItem('nav.collapsed', JSON.stringify([...next]))
      } catch {
        // ignore
      }
      return next
    })
  return [collapsed, toggle]
}

type Theme = 'light' | 'dark'

function useTheme(): [Theme, (t: Theme) => void] {
  const [theme, setTheme] = useState<Theme>(
    () => ((typeof localStorage !== 'undefined' && localStorage.getItem('theme')) as Theme) || 'light',
  )
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    try {
      localStorage.setItem('theme', theme)
    } catch {
      // ignore
    }
  }, [theme])
  return [theme, setTheme]
}

export function Layout() {
  const { user, signOut } = useAuth()
  const navigate = useNavigate()
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [isAdmin, setIsAdmin] = useState(false)
  const [theme, setTheme] = useTheme()

  useEffect(() => {
    if (!user) return
    supabase
      .from('profiles')
      .select('is_admin')
      .eq('id', user.id)
      .maybeSingle()
      .then(({ data }) => setIsAdmin(Boolean(data?.is_admin)))
  }, [user])

  const [collapsed, toggleGroup] = useCollapsedGroups()
  const initial = (user?.email ?? '?').charAt(0).toUpperCase()
  const segBase =
    'flex h-[30px] w-[38px] items-center justify-center rounded-[9px] transition'

  const renderItem = ({ to, label, icon: Icon, end }: NavItem) => (
    <NavLink
      key={to}
      to={to}
      end={end}
      onClick={() => setDrawerOpen(false)}
      className={({ isActive }) =>
        `flex w-full items-center gap-[13px] rounded-[13px] px-[13px] py-[11px] text-[15px] transition ${
          isActive
            ? 'bg-primary-soft font-bold text-primary'
            : 'font-medium text-muted hover:bg-surface-hover hover:text-text'
        }`
      }
    >
      <Icon className="h-5 w-5" />
      {label}
    </NavLink>
  )

  return (
    <div className="flex h-full bg-bg text-text">
      {/* Mobile overlay behind the drawer */}
      {drawerOpen && (
        <div
          className="fixed inset-0 z-30 bg-slate-900/40 md:hidden"
          onClick={() => setDrawerOpen(false)}
        />
      )}

      {/* Sidebar: static on md+, slide-in drawer on mobile */}
      <aside
        className={`fixed inset-y-0 left-0 z-40 flex w-[266px] flex-col border-r border-border bg-surface transition-transform duration-200 md:static md:translate-x-0 ${
          drawerOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="flex items-center gap-3 px-[22px] pb-[14px] pt-[22px]">
          <div
            className="flex h-[38px] w-[38px] items-center justify-center rounded-[11px] bg-gradient-to-br from-primary to-primary-strong text-white"
            style={{ boxShadow: '0 4px 12px rgba(99,84,232,.35)' }}
          >
            <SparkleIcon className="h-[18px] w-[18px]" />
          </div>
          <span className="text-[20px] font-extrabold tracking-tight">Intranet</span>
          <button
            className="ml-auto rounded-md p-1.5 text-faint hover:bg-surface-hover hover:text-text md:hidden"
            onClick={() => setDrawerOpen(false)}
            aria-label="Close menu"
          >
            <CloseIcon className="h-5 w-5" />
          </button>
        </div>

        <nav className="flex-1 overflow-y-auto px-[14px] py-2">
          {navGroups.map((group) => {
            const visible = group.items.filter((i) => !i.adminOnly || isAdmin)
            if (!visible.length) return null
            const isCollapsed = group.label ? collapsed.has(group.label) : false
            return (
              <div key={group.label ?? 'top'} className="mb-1.5 space-y-[3px]">
                {group.label && (
                  <button
                    onClick={() => toggleGroup(group.label!)}
                    className="flex w-full items-center justify-between px-[13px] pb-1 pt-3 text-[11px] font-bold uppercase tracking-wider text-faint transition hover:text-muted"
                    aria-expanded={!isCollapsed}
                  >
                    {group.label}
                    <ChevronDownIcon
                      className={`h-3.5 w-3.5 transition-transform ${isCollapsed ? '-rotate-90' : ''}`}
                    />
                  </button>
                )}
                {!isCollapsed && visible.map(renderItem)}
              </div>
            )
          })}

          <div className="my-2 border-t border-border" />
          {renderItem(settingsItem)}
        </nav>

        <div className="flex flex-col gap-3 border-t border-border p-[14px]">
          {/* Theme toggle */}
          <div className="flex w-max items-center gap-1 rounded-[13px] bg-surface-2 p-1">
            <button
              onClick={() => setTheme('light')}
              title="Light"
              className={`${segBase} ${
                theme === 'light' ? 'bg-surface text-primary shadow-sm' : 'text-faint hover:text-text'
              }`}
            >
              <SunIcon className="h-[17px] w-[17px]" />
            </button>
            <button
              onClick={() => setTheme('dark')}
              title="Dark"
              className={`${segBase} ${
                theme === 'dark' ? 'bg-surface text-primary shadow-sm' : 'text-faint hover:text-text'
              }`}
            >
              <MoonIcon className="h-[17px] w-[17px]" />
            </button>
          </div>

          <div className="flex items-center gap-[11px]">
            <div className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-full bg-primary-soft text-[15px] font-bold text-primary">
              {initial}
            </div>
            <span className="min-w-0 flex-1 truncate text-sm font-semibold text-muted">
              {user?.email}
            </span>
            <button
              title="Sign out"
              onClick={async () => {
                await signOut()
                navigate('/login')
              }}
              className="flex h-8 w-8 items-center justify-center rounded-[9px] text-faint hover:bg-surface-hover hover:text-text"
            >
              <LogoutIcon className="h-[18px] w-[18px]" />
            </button>
          </div>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Mobile top bar with hamburger */}
        <header className="flex items-center gap-3 border-b border-border bg-surface px-4 py-3 md:hidden">
          <button
            onClick={() => setDrawerOpen(true)}
            className="rounded-md p-1.5 text-muted hover:bg-surface-hover"
            aria-label="Open menu"
          >
            <MenuIcon className="h-5 w-5" />
          </button>
          <span className="flex items-center gap-2 text-sm font-bold tracking-tight">
            <span className="flex h-6 w-6 items-center justify-center rounded-md bg-gradient-to-br from-primary to-primary-strong text-white">
              <SparkleIcon className="h-3.5 w-3.5" />
            </span>
            Intranet
          </span>
        </header>

        <main className="min-w-0 flex-1 overflow-hidden bg-bg">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
