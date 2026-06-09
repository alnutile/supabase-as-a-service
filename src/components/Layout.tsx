import { NavLink, Outlet, useNavigate } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import {
  ArtifactIcon,
  ChatIcon,
  FileIcon,
  LogoutIcon,
  SettingsIcon,
} from './icons'

const navItems = [
  { to: '/chat', label: 'Chat', icon: ChatIcon, end: false },
  { to: '/artifacts', label: 'Artifacts', icon: ArtifactIcon, end: false },
  { to: '/files', label: 'Files', icon: FileIcon, end: false },
  { to: '/settings', label: 'Settings', icon: SettingsIcon, end: false },
]

export function Layout() {
  const { user, signOut } = useAuth()
  const navigate = useNavigate()

  const initial = (user?.email ?? '?').charAt(0).toUpperCase()

  return (
    <div className="flex h-full">
      <aside className="flex w-60 flex-col border-r border-slate-200 bg-white">
        <div className="flex items-center gap-2 px-5 py-4">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-600 text-sm font-bold text-white">
            ✺
          </div>
          <span className="text-base font-semibold tracking-tight">Intranet</span>
        </div>

        <nav className="flex-1 space-y-1 px-3 py-2">
          {navItems.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
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
              <p className="truncate text-sm font-medium text-slate-700">
                {user?.email}
              </p>
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

      <main className="min-w-0 flex-1 overflow-hidden bg-slate-50">
        <Outlet />
      </main>
    </div>
  )
}
