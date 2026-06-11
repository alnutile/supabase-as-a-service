import { useCallback, useEffect, useState } from 'react'
import type { Database } from '../lib/database.types'
import { emailInboundUrl, mcpUrl, supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import { formatDate } from '../lib/util'
import { CopyIcon, PlusIcon, TrashIcon } from '../components/icons'

type AllowedEmail = Database['public']['Tables']['allowed_emails']['Row']
type McpToken = Database['public']['Tables']['mcp_tokens']['Row']
type ModelProfile = Database['public']['Tables']['model_profiles']['Row']

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

        {isAdmin && <ModelsCard />}

        {isAdmin && <EmailCard />}

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

// Model Profiles: which model powers each named job. Admins re-point a profile's
// model id; features bind to the profile key, never a model id.
function ModelsCard() {
  const [profiles, setProfiles] = useState<ModelProfile[]>([])

  const load = useCallback(async () => {
    const { data } = await supabase
      .from('model_profiles')
      .select('*')
      .order('is_builtin', { ascending: false })
      .order('name')
    setProfiles(data ?? [])
  }, [])

  useEffect(() => {
    load()
  }, [load])

  return (
    <section className="mt-4 rounded-xl border border-slate-200 bg-white p-5">
      <h2 className="text-sm font-semibold text-slate-700">Models</h2>
      <p className="mt-1 text-sm text-slate-500">
        Which model powers each job. Edit the id to re-point a profile — applied on the next message,
        no redeploy needed.
      </p>
      <div className="mt-4 space-y-3">
        {profiles.map((p) => (
          <ModelProfileRow key={p.id} profile={p} />
        ))}
      </div>
    </section>
  )
}

function ModelProfileRow({ profile }: { profile: ModelProfile }) {
  const [model, setModel] = useState(profile.model)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const dirty = model.trim() !== profile.model

  async function save() {
    setSaving(true)
    await supabase
      .from('model_profiles')
      .update({ model: model.trim(), updated_at: new Date().toISOString() })
      .eq('id', profile.id)
    setSaving(false)
    setSaved(true)
    setTimeout(() => setSaved(false), 1500)
  }

  return (
    <div className="rounded-lg border border-slate-200 p-3">
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium text-slate-800">{profile.name}</span>
        <span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[10px] text-slate-500">
          {profile.key}
        </span>
      </div>
      <p className="mt-0.5 text-xs text-slate-500">{profile.description}</p>
      <div className="mt-2 flex gap-2">
        <input
          value={model}
          onChange={(e) => setModel(e.target.value)}
          spellCheck={false}
          className="min-w-0 flex-1 rounded-lg border border-slate-300 px-3 py-2 font-mono text-xs outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
        />
        <button
          onClick={save}
          disabled={saving || !dirty || !model.trim()}
          className="shrink-0 rounded-lg bg-brand-600 px-3 py-2 text-xs font-semibold text-white hover:bg-brand-700 disabled:opacity-50"
        >
          {saving ? 'Saving…' : saved ? 'Saved!' : 'Save'}
        </button>
      </div>
    </div>
  )
}

// Workspace email integration (admin-only). The API key is write-only: it's
// never read back into the browser — it lives in Vault, written through the
// set_email_integration RPC. Once configured we show the inbound endpoint to
// paste into the provider so incoming mail flows to check_email.
type EmailIntegration = {
  provider: 'postmark' | 'resend'
  from_address: string
  inbound_token: string | null
  allowed_recipients: string[] | null
}

function EmailCard() {
  const [existing, setExisting] = useState<EmailIntegration | null>(null)
  const [loading, setLoading] = useState(true)
  const [provider, setProvider] = useState<'postmark' | 'resend'>('postmark')
  const [fromAddress, setFromAddress] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [recipients, setRecipients] = useState('')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const load = useCallback(async () => {
    const { data } = await supabase
      .from('integrations')
      .select('provider, from_address, inbound_token, allowed_recipients')
      .eq('kind', 'email')
      .maybeSingle()
    if (data) {
      const row = data as EmailIntegration
      setExisting(row)
      setProvider(row.provider)
      setFromAddress(row.from_address)
      setRecipients((row.allowed_recipients ?? []).join('\n'))
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    load()
  }, [load])

  async function save() {
    setError(null)
    if (!fromAddress.trim()) {
      setError('A from-address is required.')
      return
    }
    if (!existing && !apiKey.trim()) {
      setError('An API key is required to set up email.')
      return
    }
    setSaving(true)
    const allowed = recipients
      .split(/[\n,]/)
      .map((r) => r.trim())
      .filter(Boolean)
    const { error: rpcError } = await supabase.rpc('set_email_integration', {
      p_provider: provider,
      p_from_address: fromAddress.trim(),
      p_api_key: apiKey.trim() || '', // empty = keep existing key
      p_allowed_recipients: allowed.length ? allowed : null,
    })
    setSaving(false)
    if (rpcError) {
      setError(rpcError.message)
      return
    }
    setApiKey('')
    setSaved(true)
    setTimeout(() => setSaved(false), 1500)
    load()
  }

  async function copyInbound() {
    if (!existing?.inbound_token) return
    await navigator.clipboard.writeText(emailInboundUrl(existing.inbound_token))
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <section className="mt-4 rounded-xl border border-slate-200 bg-white p-5">
      <h2 className="text-sm font-semibold text-slate-700">Email</h2>
      <p className="mt-1 text-sm text-slate-500">
        Configure email once and any user or agent can send and check mail —{' '}
        <em>“email me a summary every morning.”</em> The API key is stored in Supabase Vault, never in
        the browser.
      </p>

      {loading ? (
        <p className="mt-4 text-sm text-slate-400">Loading…</p>
      ) : (
        <div className="mt-4 space-y-4">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-600">Provider</span>
            <select
              value={provider}
              onChange={(e) => setProvider(e.target.value as 'postmark' | 'resend')}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
            >
              <option value="postmark">Postmark</option>
              <option value="resend">Resend</option>
            </select>
          </label>

          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-600">From address</span>
            <input
              value={fromAddress}
              onChange={(e) => setFromAddress(e.target.value)}
              placeholder="intranet@yourdomain.com"
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
            />
          </label>

          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-600">
              API key {existing && <span className="text-slate-400">— leave blank to keep the current key</span>}
            </span>
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              autoComplete="off"
              placeholder={existing ? '••• configured' : 'Provider API key'}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-xs outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
            />
          </label>

          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-600">
              Allowed recipients <span className="text-slate-400">— optional, one per line</span>
            </span>
            <textarea
              value={recipients}
              onChange={(e) => setRecipients(e.target.value)}
              rows={2}
              placeholder={'@yourcompany.com\nalerts@partner.com'}
              className="w-full resize-y rounded-lg border border-slate-300 px-3 py-2 font-mono text-xs outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
            />
            <span className="mt-1 block text-[11px] text-slate-400">
              Blank = send anywhere. Use exact addresses or <code>@domain.com</code> suffixes to limit where mail can go.
            </span>
          </label>

          {error && <p className="text-xs text-red-600">{error}</p>}

          <button
            onClick={save}
            disabled={saving}
            className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-60"
          >
            {saving ? 'Saving…' : saved ? 'Saved!' : existing ? 'Update email' : 'Set up email'}
          </button>

          {existing?.inbound_token && (
            <div className="mt-2 rounded-lg border border-slate-200 bg-slate-50 p-3">
              <p className="text-xs font-medium text-slate-600">Receiving email</p>
              <p className="mt-1 text-[11px] text-slate-500">
                Point a <strong>dedicated</strong> address at this inbound endpoint (not a personal mailbox) —
                everything sent to it becomes readable by <code>check_email</code>.
              </p>
              <div className="mt-2 flex items-start gap-2">
                <pre className="min-w-0 flex-1 overflow-x-auto rounded-lg bg-slate-900 p-2 text-[11px] leading-relaxed text-slate-100">
                  {emailInboundUrl(existing.inbound_token)}
                </pre>
                <button
                  onClick={copyInbound}
                  className="shrink-0 rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50"
                >
                  {copied ? 'Copied' : 'Copy'}
                </button>
              </div>
              <ul className="mt-2 space-y-1 text-[11px] text-slate-500">
                <li>
                  <strong>Postmark:</strong> Servers → your server → <em>Inbound</em> → set the inbound webhook URL to the link above.
                </li>
                <li>
                  <strong>Resend:</strong> Domains → Inbound → add an endpoint pointing at the link above.
                </li>
              </ul>
            </div>
          )}
        </div>
      )}
    </section>
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
        Connect <strong>Claude Code</strong> (the CLI) to this workspace, then say
        “build an agent that does X on my intranet” and Claude pushes it here — it shows up under
        Agents, Tools, and Webhooks. Generate a token below and run the one-line command it gives you.
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
          const cmd = `claude mcp add --scope user --transport http intranet ${mcpUrl} --header "Authorization: Bearer ${t.token}"`
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

              <p className="mt-2 text-xs font-medium text-slate-500">
                1. Run this in your terminal (anywhere — <code className="rounded bg-slate-100 px-1">--scope user</code>{' '}
                makes it available in every project):
              </p>
              <div className="mt-1 flex items-start gap-2">
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

              <p className="mt-2 text-xs text-slate-500">
                2. Start <code className="rounded bg-slate-100 px-1">claude</code> and run{' '}
                <code className="rounded bg-slate-100 px-1">/mcp</code> — you should see{' '}
                <strong>intranet</strong> connected. Then ask it to “list my intranet agents” to confirm.
              </p>
              <p className="mt-1 text-[11px] text-slate-400">
                Treat this token like a password — anyone with it can act as you here. Revoke it (🗑) if it leaks.
              </p>
            </div>
          )
        })}
        {tokens.length === 0 && (
          <p className="text-xs text-slate-400">No connection tokens yet.</p>
        )}
      </div>

      <p className="mt-4 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700">
        <strong>Using Claude Desktop or claude.ai?</strong> Their “Add custom connector” dialog only
        speaks OAuth, which this token-based server doesn’t offer yet — it’ll fail to register. Use the
        Claude Code command above for now. (OAuth sign-in is on the roadmap.)
      </p>
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
