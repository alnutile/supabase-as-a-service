import { useEffect, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../contexts/AuthContext'
import { LockIcon } from '../../components/icons'

// Whether the signed-in user is a workspace admin. Settings sub-pages that only
// admins should reach use this to render an AdminGate instead of the content
// (the sidebar already hides the links, but a direct URL shouldn't leak).
export function useIsAdmin(): { isAdmin: boolean; loading: boolean } {
  const { user } = useAuth()
  const [isAdmin, setIsAdmin] = useState(false)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!user) return
    supabase
      .from('profiles')
      .select('is_admin')
      .eq('id', user.id)
      .maybeSingle()
      .then(({ data }) => {
        setIsAdmin(Boolean(data?.is_admin))
        setLoading(false)
      })
  }, [user])

  return { isAdmin, loading }
}

// Scroll container + header shared by every Settings sub-page, so they all read
// the same as the old single Settings page did.
export function SettingsShell({
  title,
  subtitle,
  children,
}: {
  title: string
  subtitle?: string
  children: React.ReactNode
}) {
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-2xl px-6 py-8">
        <h1 className="text-2xl font-semibold tracking-tight text-text">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-muted">{subtitle}</p>}
        {children}
      </div>
    </div>
  )
}

export function AdminGate({ message }: { message: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-faint">
      <LockIcon className="h-10 w-10" />
      <p className="max-w-sm text-sm">{message}</p>
    </div>
  )
}
