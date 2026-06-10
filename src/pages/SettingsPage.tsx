import { useCallback, useEffect, useState } from 'react'
import type { Database } from '../lib/database.types'
import { mcpUrl, supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import { formatDate } from '../lib/util'
import { CopyIcon, PlusIcon, TrashIcon } from '../components/icons'

type AllowedEmail = Database['public']['Tables']['allowed_emails']['Row']
type McpToken = Database['public']['Tables']['mcp_tokens']['Row']

export default function SettingsPage() {
  const { user } = useAuth()
  const [displayName, setDisplayName] = useState('')
  const [isAdmin, setIsAdmin] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    if (!user) return
    supabase
      .from('profiles')
      .select('display_name, is_admin')
      .eq('id', user.id)
      .maybeSingle()
      .then(({ data }) => {
        setDisplayName(data?.display_name ?? '')
        setIsAdmin(Boolean(data?.is_admin))
      })
  }, [user])

  async function save() {
    if (!user) return
    setSaving(true)
    await supabase
      .from('profiles')
      .upsert({ id: user.id, email: user.email, display_name: displayName, updated_at: new Date().toISOString() })
    setSaving(false)
    setSaved(true)
    setTimeout(() => setSaved(false), 1500)
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-2xl px-6 py-8">
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900">Settings</h1>
        <p className="mt-1 text-sm text-slate-500">Manage your profile and account.</p>

        <section className="mt-6 rounded-xl border border-slate-200 bg-white p-5">
          <h2 className="text-sm font-semibold text-slate-700">Profile</h2>
          <div className="mt-4 space-y-4">
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-slate-600">Email</span>
              <input
                value={user?.email ?? ''}
                readOnly
                className="w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-500"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-slate-600">Display name</span>
              <input
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="Your name"
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
              />
            </label>
            <button
              onClick={save}
              disabled={saving}
              className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-brand-700 disabled:opacity-60"
            >
              {saving ? 'Saving…' : saved ? 'Saved!' : 'Save'}
            </button>
          </div>
        </section>

        {isAdmin && <InvitePeople />}

        <ConnectClaude />

        <section className="mt-4 rounded-xl border border-slate-200 bg-white p-5">
          <h2 className="text-sm font-semibold text-slate-700">About this workspace</h2>
          <p className="mt-2 text-sm leading-relaxed text-slate-500">
            This intranet runs on Supabase — authentication, your data (protected by
            row-level security), file storage, and realtime updates over websockets. The AI
            assistant is powered by a Supabase Edge Function that keeps the model API key on
            the server.
          </p>
        </section>
      </div>
    </div>
  )
}

function ConnectClaude() {
  const { user } = useAuth()
  const [tokens, setTokens] = useState<McpToken[]>([])
  const [copied, setCopied] = useState<string | null>(null)

  const load = useCallback(async () => {
    const { data } = await supabase
      .from('mcp_tokens')
      .select('*')
      .order('created_at', { ascending: false })
    setTokens(data ?? [])
  }, [])

  useEffect(() => {
    load()
  }, [load])

  async function generate() {
    await supabase.from('mcp_tokens').insert({ owner_id: user!.id, name: 'Claude' })
    load()
  }

  async function revoke(id: string) {
    await supabase.from('mcp_tokens').delete().eq('id', id)
    load()
  }

  async function copy(text: string, key: string) {
    await navigator.clipboard.writeText(text)
    setCopied(key)
    setTimeout(() => setCopied(null), 1500)
  }

  return (
    <section className="mt-4 rounded-xl border border-slate-200 bg-white p-5">
      <h2 className="text-sm font-semibold text-slate-700">Connect Claude (MCP)</h2>
      <p className="mt-1 text-sm text-slate-500">
        Generate a token and connect Claude Code or Claude Desktop to this workspace. Then you can
        say “build an agent that does X on my intranet” and Claude pushes it here — it shows up under
        Agents, Tools, and Webhooks.
      </p>

      <div className="mt-3 flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-700">
          {mcpUrl}
        </code>
        <button
          onClick={() => copy(mcpUrl, 'url')}
          className="flex shrink-0 items-center gap-1 rounded-lg border border-slate-300 px-2.5 py-2 text-xs font-medium text-slate-600 hover:bg-slate-50"
        >
          <CopyIcon className="h-3.5 w-3.5" /> {copied === 'url' ? 'Copied' : 'Copy'}
        </button>
      </div>

      <div className="mt-4">
        <button
          onClick={generate}
          className="flex items-center gap-1.5 rounded-lg bg-brand-600 px-3 py-2 text-sm font-semibold text-white hover:bg-brand-700"
        >
          <PlusIcon className="h-4 w-4" /> New connection token
        </button>
      </div>

      <div className="mt-3 space-y-3">
        {tokens.map((t) => {
          const cmd = `claude mcp add --transport http intranet ${mcpUrl} --header "Authorization: Bearer ${t.token}"`
          return (
            <div key={t.id} className="rounded-lg border border-slate-200 p-3">
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium text-slate-600">
                  {t.name} · {t.last_used_at ? `last used ${formatDate(t.last_used_at)}` : 'never used'}
                </span>
                <button
                  onClick={() => revoke(t.id)}
                  className="ml-auto rounded-md p-1 text-slate-400 hover:bg-red-50 hover:text-red-600"
                  title="Revoke"
                >
                  <TrashIcon className="h-4 w-4" />
                </button>
              </div>
              <div className="mt-2 flex items-start gap-2">
                <pre className="min-w-0 flex-1 overflow-x-auto rounded-lg bg-slate-900 p-2 text-[11px] leading-relaxed text-slate-100">
                  {cmd}
                </pre>
                <button
                  onClick={() => copy(cmd, t.id)}
                  className="shrink-0 rounded-lg border border-slate-300 px-2 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50"
                >
                  {copied === t.id ? 'Copied' : 'Copy'}
                </button>
              </div>
            </div>
          )
        })}
        {tokens.length === 0 && (
          <p className="text-xs text-slate-400">No connection tokens yet.</p>
        )}
      </div>
    </section>
  )
}

function InvitePeople() {
  const { user } = useAuth()
  const [emails, setEmails] = useState<AllowedEmail[]>([])
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    const { data } = await supabase
      .from('allowed_emails')
      .select('*')
      .order('created_at', { ascending: false })
    setEmails(data ?? [])
  }, [])

  useEffect(() => {
    load()
  }, [load])

  async function add(e: React.FormEvent) {
    e.preventDefault()
    const email = value.trim().toLowerCase()
    if (!email || !email.includes('@')) {
      setError('Enter a valid email address.')
      return
    }
    setBusy(true)
    setError(null)
    const { error: insErr } = await supabase
      .from('allowed_emails')
      .insert({ email, invited_by: user!.id })
    setBusy(false)
    if (insErr) {
      setError(insErr.code === '23505' ? 'That email is already invited.' : insErr.message)
      return
    }
    setValue('')
    load()
  }

  async function remove(email: string) {
    await supabase.from('allowed_emails').delete().eq('email', email)
    load()
  }

  return (
    <section className="mt-4 rounded-xl border border-slate-200 bg-white p-5">
      <h2 className="text-sm font-semibold text-slate-700">Invite people</h2>
      <p className="mt-1 text-sm text-slate-500">
        This workspace is invite-only. Add an email here, then the person can sign up with it
        at your app’s login page.
      </p>

      <form onSubmit={add} className="mt-4 flex gap-2">
        <input
          type="email"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="teammate@company.com"
          className="min-w-0 flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
        />
        <button
          type="submit"
          disabled={busy}
          className="flex items-center gap-1.5 rounded-lg bg-brand-600 px-3 py-2 text-sm font-semibold text-white transition hover:bg-brand-700 disabled:opacity-60"
        >
          <PlusIcon className="h-4 w-4" /> Invite
        </button>
      </form>
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}

      <div className="mt-4 divide-y divide-slate-100 overflow-hidden rounded-lg border border-slate-200">
        {emails.length === 0 ? (
          <p className="px-3 py-4 text-center text-sm text-slate-400">No invites yet.</p>
        ) : (
          emails.map((e) => (
            <div key={e.email} className="flex items-center gap-3 px-3 py-2">
              <span className="min-w-0 flex-1 truncate text-sm text-slate-700">{e.email}</span>
              <span className="text-xs text-slate-400">{formatDate(e.created_at)}</span>
              <button
                onClick={() => remove(e.email)}
                title="Remove invite"
                className="rounded-md p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600"
              >
                <TrashIcon className="h-4 w-4" />
              </button>
            </div>
          ))
        )}
      </div>
    </section>
  )
}
