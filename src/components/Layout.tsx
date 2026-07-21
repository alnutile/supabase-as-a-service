import { useEffect, useState } from 'react'
import { NavLink, Outlet, useNavigate } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import { supabase } from '../lib/supabase'
import { GlobalSearch, isMac, openGlobalSearch } from './GlobalSearch'
import {
  navGroups,
  settingsGroup,
  visibleGroups,
  type FlagMap,
  type NavGroup,
  type NavItem,
} from '../lib/nav'
import {
  ArrowRightIcon,
  ChevronDownIcon,
  CloseIcon,
  LogoutIcon,
  MenuIcon,
  MoonIcon,
  SearchIcon,
  SparkleIcon,
  SunIcon,
} from './icons'

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

// Desktop "rail" mode: collapse the sidebar to an icons-only strip to reclaim
// horizontal room in the triple-column pages. Persisted; only affects md+ (the
// mobile drawer always shows full labels).
function useRail(): [boolean, () => void] {
  const [railed, setRailed] = useState<boolean>(() => {
    try {
      return localStorage.getItem('nav.rail') === '1'
    } catch {
      return false
    }
  })
  const toggle = () =>
    setRailed((v) => {
      const next = !v
      try {
        localStorage.setItem('nav.rail', next ? '1' : '0')
      } catch {
        // ignore
      }
      return next
    })
  return [railed, toggle]
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
  const [flags, setFlags] = useState<FlagMap>({})
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

  // Feature flags hide/show sidebar areas workspace-wide. Load them once, then
  // subscribe to changes so toggling on the Feature Flags page updates every
  // open sidebar live (feature_flags is in the realtime publication, 0065).
  useEffect(() => {
    if (!user) return
    const loadFlags = () =>
      supabase
        .from('feature_flags')
        .select('key, enabled')
        .then(({ data }) => {
          const map: FlagMap = {}
          for (const row of data ?? []) map[row.key] = row.enabled
          setFlags(map)
        })
    loadFlags()
    const channel = supabase
      .channel('feature-flags')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'feature_flags' }, loadFlags)
      .subscribe()
    return () => {
      supabase.removeChannel(channel)
    }
  }, [user])

  const [collapsed, toggleGroup] = useCollapsedGroups()
  const [railed, toggleRail] = useRail()
  const initial = (user?.email ?? '?').charAt(0).toUpperCase()
  const segBase =
    'flex h-[30px] w-[38px] items-center justify-center rounded-[9px] transition'
  // When railed, hide this element on desktop but keep it in the mobile drawer.
  const railHide = railed ? 'md:hidden' : ''

  const renderItem = ({ to, label, icon: Icon, end }: NavItem) => (
    <NavLink
      key={to}
      to={to}
      end={end}
      onClick={() => setDrawerOpen(false)}
      title={label}
      className={({ isActive }) =>
        `flex w-full items-center gap-[13px] rounded-[13px] px-[13px] py-[11px] text-[15px] transition ${
          railed ? 'md:justify-center md:gap-0 md:px-0' : ''
        } ${
          isActive
            ? 'bg-primary-soft font-bold text-primary'
            : 'font-medium text-muted hover:bg-surface-hover hover:text-text'
        }`
      }
    >
      <Icon className="h-5 w-5 shrink-0" />
      <span className={railHide}>{label}</span>
    </NavLink>
  )

  const renderGroup = (group: NavGroup) => {
    const isCollapsed = group.label ? collapsed.has(group.label) : false
    return (
      <div key={group.label ?? 'top'} className="mb-1.5 space-y-[3px]">
        {group.label && (
          <button
            onClick={() => toggleGroup(group.label!)}
            className={`flex w-full items-center justify-between px-[13px] pb-1 pt-3 text-[11px] font-bold uppercase tracking-wider text-faint transition hover:text-muted ${railHide}`}
            aria-expanded={!isCollapsed}
          >
            {group.label}
            <ChevronDownIcon
              className={`h-3.5 w-3.5 transition-transform ${isCollapsed ? '-rotate-90' : ''}`}
            />
          </button>
        )}
        {/* When railed, headers are hidden, so always show the items. */}
        {(railed || !isCollapsed) && group.items.map(renderItem)}
      </div>
    )
  }

  // Apply admin gating + feature flags to the sidebar. Settings is a section of
  // its own, pinned to the bottom (its items are always-on, so flags never hide
  // them — an admin can't lock themselves out of the flags page).
  const mainGroups = visibleGroups(navGroups, { flags, isAdmin })
  const [settingsVisible] = visibleGroups([settingsGroup], { flags, isAdmin })

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
        className={`fixed inset-y-0 left-0 z-40 flex w-[266px] flex-col border-r border-border bg-surface transition-[width,transform] duration-200 md:static md:translate-x-0 ${
          drawerOpen ? 'translate-x-0' : '-translate-x-full'
        } ${railed ? 'md:w-[70px]' : 'md:w-[266px]'}`}
      >
        <div
          className={`flex items-center gap-3 px-[22px] pb-[14px] pt-[22px] ${
            railed ? 'md:justify-center md:px-0' : ''
          }`}
        >
          <div
            className="flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-[11px] bg-gradient-to-br from-primary to-primary-strong text-white"
            style={{ boxShadow: '0 4px 12px rgba(21,121,91,.35)' }}
          >
            <SparkleIcon className="h-[18px] w-[18px]" />
          </div>
          <span className={`text-[20px] font-extrabold tracking-tight ${railHide}`}>SupaNet</span>
          <button
            className="ml-auto rounded-md p-1.5 text-faint hover:bg-surface-hover hover:text-text md:hidden"
            onClick={() => setDrawerOpen(false)}
            aria-label="Close menu"
          >
            <CloseIcon className="h-5 w-5" />
          </button>
        </div>

        {/* Global search trigger (⌘K / Ctrl+K also opens it) */}
        <div className="px-[14px] pb-1">
          <button
            onClick={() => {
              setDrawerOpen(false)
              openGlobalSearch()
            }}
            title="Search"
            aria-label="Search"
            className={`flex w-full items-center gap-[13px] rounded-[13px] border border-border bg-surface-2 px-[13px] py-[9px] text-[14px] font-medium text-faint transition hover:border-border-strong hover:text-muted ${
              railed ? 'md:justify-center md:gap-0 md:border-none md:bg-transparent md:px-0' : ''
            }`}
          >
            <SearchIcon className="h-[18px] w-[18px] shrink-0" />
            <span className={`flex-1 text-left ${railHide}`}>Search</span>
            <kbd className={`rounded-md border border-border bg-surface px-1.5 py-0.5 text-[11px] font-semibold ${railHide}`}>
              {isMac ? '⌘K' : 'Ctrl K'}
            </kbd>
          </button>
        </div>

        <nav className="flex-1 overflow-y-auto px-[14px] py-2">
          {mainGroups.map(renderGroup)}

          {settingsVisible && (
            <>
              <div className="my-2 border-t border-border" />
              {renderGroup(settingsVisible)}
            </>
          )}
        </nav>

        <div className="flex flex-col gap-3 border-t border-border p-[14px]">
          {/* Desktop rail toggle (icons-only ↔ icons+text) */}
          <button
            onClick={toggleRail}
            title={railed ? 'Expand sidebar' : 'Collapse sidebar'}
            aria-label={railed ? 'Expand sidebar' : 'Collapse sidebar'}
            className={`hidden items-center gap-[13px] rounded-[13px] px-[13px] py-[9px] text-sm font-medium text-muted transition hover:bg-surface-hover hover:text-text md:flex ${
              railed ? 'md:justify-center md:gap-0 md:px-0' : ''
            }`}
          >
            <ArrowRightIcon className={`h-5 w-5 shrink-0 transition-transform ${railed ? '' : 'rotate-180'}`} />
            <span className={railHide}>Collapse</span>
          </button>

          {/* Theme toggle */}
          <div className={`flex w-max items-center gap-1 rounded-[13px] bg-surface-2 p-1 ${railHide}`}>
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

          <div className={`flex items-center gap-[11px] ${railed ? 'md:flex-col md:gap-2' : ''}`}>
            <div className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-full bg-primary-soft text-[15px] font-bold text-primary">
              {initial}
            </div>
            <span className={`min-w-0 flex-1 truncate text-sm font-semibold text-muted ${railHide}`}>
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
            SupaNet
          </span>
          <button
            onClick={openGlobalSearch}
            className="ml-auto rounded-md p-1.5 text-muted hover:bg-surface-hover"
            aria-label="Search"
          >
            <SearchIcon className="h-5 w-5" />
          </button>
        </header>

        <main className="min-w-0 flex-1 overflow-hidden bg-bg">
          <Outlet />
        </main>
      </div>

      <GlobalSearch isAdmin={isAdmin} flags={flags} />
    </div>
  )
}
