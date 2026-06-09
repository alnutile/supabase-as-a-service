import { useState } from 'react'
import { NavLink, Outlet, useNavigate } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import {
  ArtifactIcon,
  ChatIcon,
  CloseIcon,
  FileIcon,
  LogoutIcon,
  MenuIcon,
  SettingsIcon,
  SkillIcon,
  WebhookIcon,
} from './icons'

const navItems = [
  { to: '/chat', label: 'Chat', icon: ChatIcon, end: false },
  { to: '/artifacts', label: 'Artifacts', icon: ArtifactIcon, end: false },
  { to: '/skills', label: 'Skills', icon: SkillIcon, end: false },
  { to: '/webhooks', label: 'Webhooks', icon: WebhookIcon, end: false },
  { to: '/files', label: 'Files', icon: FileIcon, end: false },
  { to: '/settings', label: 'Settings', icon: SettingsIcon, end: false },
]

export function Layout() {
  const { user, signOut } = useAuth()
  const navigate = useNavigate()
  const [drawerOpen, setDrawerOpen] = useState(false)

  const initial = (user?.email ?? '?').charAt(0).toUpperCase()

  return (
    <div className="flex h-full">
      {/* Mobile overlay behind the drawer */}
      {drawerOpen && (
        <div
          className="fixed inset-0 z-30 bg-slate-900/40 md:hidden"
          onClick={() => setDrawerOpen(false)}
        />
      )}

      {/* Sidebar: static on md+, slide-in drawer on mobile */}
      <aside
        className={`fixed inset-y-0 left-0 z-40 flex w-64 flex-col border-r border-slate-200 bg-white transition-transform duration-200 md:static md:w-60 md:translate-x-0 ${
          drawerOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="flex items-center gap-2 px-5 py-4">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-600 text-sm font-bold text-white">
            ✺
          </div>
          <span className="text-base font-semibold tracking-tight">Intranet</span>
          <button
            className="ml-auto rounded-md p-1.5 text-slate-400 hover:bg-slate-100 md:hidden"
            onClick={() => setDrawerOpen(false)}
            aria-label="Close menu"
          >
            <CloseIcon className="h-5 w-5" />
          </button>
        </div>

        <nav className="flex-1 space-y-1 px-3 py-2">
          {navItems.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              onClick={() => setDrawerOpen(false)}
              className={({ isActive }) =>
                `flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition ${
                  isActive
                    ? 'bg-brand-50 text-brand-700'
                    : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
                }`
              }
            >
              <Icon className="h-[18px] w-[18px]" />
              {label}
            </NavLink>
          ))}
        </nav>

        <div className="border-t border-slate-200 p-3">
          <div className="flex items-center gap-3 rounded-lg px-2 py-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-slate-200 text-sm font-semibold text-slate-700">
              {initial}
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-slate-700">{user?.email}</p>
            </div>
            <button
              title="Sign out"
              onClick={async () => {
                await signOut()
                navigate('/login')
              }}
              className="rounded-md p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
            >
              <LogoutIcon className="h-[18px] w-[18px]" />
            </button>
          </div>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Mobile top bar with hamburger */}
        <header className="flex items-center gap-3 border-b border-slate-200 bg-white px-4 py-3 md:hidden">
          <button
            onClick={() => setDrawerOpen(true)}
            className="rounded-md p-1.5 text-slate-600 hover:bg-slate-100"
            aria-label="Open menu"
          >
            <MenuIcon className="h-5 w-5" />
          </button>
          <span className="flex items-center gap-2 text-sm font-semibold tracking-tight">
            <span className="flex h-6 w-6 items-center justify-center rounded-md bg-brand-600 text-xs text-white">
              ✺
            </span>
            Intranet
          </span>
        </header>

        <main className="min-w-0 flex-1 overflow-hidden bg-slate-50">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
