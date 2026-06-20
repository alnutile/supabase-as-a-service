import { useEffect, useState } from 'react'
import { NavLink, Outlet, useNavigate } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import { supabase } from '../lib/supabase'
import {
  ActivityIcon,
  AgentIcon,
  ArtifactIcon,
  ChatIcon,
  CloseIcon,
  EvalIcon,
  FileIcon,
  ForgeIcon,
  HomeIcon,
  LogoutIcon,
  MenuIcon,
  MoonIcon,
  PluginIcon,
  SettingsIcon,
  ShieldIcon,
  SkillIcon,
  SparkleIcon,
  SunIcon,
  ToolIcon,
  UsageIcon,
  WebhookIcon,
} from './icons'

const navItems = [
  { to: '/home', label: 'Home', icon: HomeIcon, end: false, adminOnly: false },
  { to: '/chat', label: 'Chat', icon: ChatIcon, end: false, adminOnly: false },
  { to: '/agents', label: 'Agents', icon: AgentIcon, end: false, adminOnly: false },
  { to: '/artifacts', label: 'Artifacts', icon: ArtifactIcon, end: false, adminOnly: false },
  { to: '/skills', label: 'Skills', icon: SkillIcon, end: false, adminOnly: false },
  { to: '/tools', label: 'Tools', icon: ToolIcon, end: false, adminOnly: false },
  { to: '/forge', label: 'Forge', icon: ForgeIcon, end: false, adminOnly: true },
  { to: '/guardrails', label: 'Guardrails', icon: ShieldIcon, end: false, adminOnly: true },
  { to: '/evals', label: 'Evals', icon: EvalIcon, end: false, adminOnly: true },
  { to: '/webhooks', label: 'Webhooks', icon: WebhookIcon, end: false, adminOnly: false },
  { to: '/activity', label: 'Activity', icon: ActivityIcon, end: false, adminOnly: false },
  { to: '/usage', label: 'Usage', icon: UsageIcon, end: false, adminOnly: true },
  { to: '/files', label: 'Files', icon: FileIcon, end: false, adminOnly: false },
  { to: '/plugins', label: 'Plugins', icon: PluginIcon, end: false, adminOnly: false },
  { to: '/settings', label: 'Settings', icon: SettingsIcon, end: false, adminOnly: false },
]

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

  const items = navItems.filter((i) => !i.adminOnly || isAdmin)
  const initial = (user?.email ?? '?').charAt(0).toUpperCase()
  const segBase =
    'flex h-[30px] w-[38px] items-center justify-center rounded-[9px] transition'

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

        <nav className="flex-1 space-y-[3px] overflow-y-auto px-[14px] py-2">
          {items.map(({ to, label, icon: Icon, end }) => (
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
          ))}
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
