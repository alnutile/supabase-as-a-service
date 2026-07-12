import { useCallback, useEffect, useState } from 'react'
import type { Database } from '../../lib/database.types'
import { emailInboundUrl, mcpUrl, slackEventsUrl, supabase } from '../../lib/supabase'
import { useAuth } from '../../contexts/AuthContext'
import { formatDate } from '../../lib/util'
import { CopyIcon, PlusIcon, TrashIcon } from '../../components/icons'
import { bindingToForm, buildSlackBindingPayload } from '../../lib/slackBinding'

export { ConnectClaude } from './ConnectClaudeCard'

// NOTE: The old ConnectClaude function (lines ~689-809) should be removed but is kept
// temporarily to avoid TS errors. Only the export above should remain. See ConnectClaudeCard.tsx
// for the new implementation with Claude Desktop instructions.

// The Settings cards live here so the per-area Settings pages
// (src/pages/settings/*.tsx) can each render one. They were split out of the
// old single SettingsPage when Settings became a sidebar section (issue #122).

type AllowedEmail = Database['public']['Tables']['allowed_emails']['Row']
type McpToken = Database['public']['Tables']['mcp_tokens']['Row']
type ModelProfile = Database['public']['Tables']['model_profiles']['Row']

// Your profile — email (read-only) + display name.
export function ProfileCard() {
  const { user } = useAuth()
  const [displayName, setDisplayName] = useState('')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    if (!user) return
    supabase
      .from('profiles')
      .select('display_name')
      .eq('id', user.id)
      .maybeSingle()
      .then(({ data }) => setDisplayName(data?.display_name ?? ''))
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
    <section className="mt-6 rounded-xl border border-border bg-surface p-5">
      <h2 className="text-sm font-semibold text-text">Profile</h2>
      <div className="mt-4 space-y-4">
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-muted">Email</span>
          <input
            value={user?.email ?? ''}
            readOnly
            className="w-full rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm text-muted"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-muted">Display name</span>
          <input
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="Your name"
            className="w-full rounded-lg border border-border-strong px-3 py-2 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary-soft"
          />
        </label>
        <button
          onClick={save}
          disabled={saving}
          className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white transition hover:bg-primary-strong disabled:opacity-60"
        >
          {saving ? 'Saving…' : saved ? 'Saved!' : 'Save'}
        </button>
      </div>
    </section>
  )
}

export function AboutCard() {
  return (
    <section className="mt-4 rounded-xl border border-border bg-surface p-5">
      <h2 className="text-sm font-semibold text-text">About this workspace</h2>
      <p className="mt-2 text-sm leading-relaxed text-muted">
        This intranet runs on Supabase — authentication, your data (protected by
        row-level security), file storage, and realtime updates over websockets. The AI
        assistant is powered by a Supabase Edge Function that keeps the model API key on
        the server.
      </p>
    </section>
  )
}

// Model Profiles: which model powers each named job. Admins re-point a profile's
// model id; features bind to the profile key, never a model id.
export function ModelsCard() {
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
    <section className="mt-6 rounded-xl border border-border bg-surface p-5">
      <h2 className="text-sm font-semibold text-text">Models</h2>
      <p className="mt-1 text-sm text-muted">
        Which model powers each job. Edit the id to re-point a profile — applied on the next message,
        no redeploy needed. Use an{' '}
        <a
          href="https://openrouter.ai/models"
          target="_blank"
          rel="noreferrer"
          className="text-primary underline"
        >
          OpenRouter model slug
        </a>{' '}
        (e.g. <code>anthropic/claude-sonnet-4.5</code>, <code>openai/gpt-4o-mini</code>).
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
    <div className="rounded-lg border border-border p-3">
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium text-text">{profile.name}</span>
        <span className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[10px] text-muted">
          {profile.key}
        </span>
      </div>
      <p className="mt-0.5 text-xs text-muted">{profile.description}</p>
      <div className="mt-2 flex gap-2">
        <input
          value={model}
          onChange={(e) => setModel(e.target.value)}
          spellCheck={false}
          className="min-w-0 flex-1 rounded-lg border border-border-strong px-3 py-2 font-mono text-xs outline-none focus:border-primary focus:ring-2 focus:ring-primary-soft"
        />
        <button
          onClick={save}
          disabled={saving || !dirty || !model.trim()}
          className="shrink-0 rounded-lg bg-primary px-3 py-2 text-xs font-semibold text-white hover:bg-primary-strong disabled:opacity-50"
        >
          {saving ? 'Saving…' : saved ? 'Saved!' : 'Save'}
        </button>
      </div>
    </div>
  )
}

// External MCP servers (admin-only). Connect ANY number of MCP endpoints (e.g.
// Zapier MCP in front of Gmail/Calendar, plus others); each server's remote tools
// become callable by chat, scheduled agents, and webhook agents. Each bearer token
// is write-only — stored in Vault via set_mcp_server, never read back into the
// browser. "Connect & list tools" validates a server and caches its toolset.
type McpServer = {
  id: string
  label: string
  url: string
  tool_id: string | null
  cached_tools: { name: string }[] | null
  is_active: boolean
}

export function McpCard() {
  const [servers, setServers] = useState<McpServer[]>([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<string | 'new' | null>(null)
  const [results, setResults] = useState<Record<string, { ok: boolean; message: string; tools?: string[] }>>({})

  const load = useCallback(async () => {
    const { data: srv } = await supabase
      .from('mcp_servers')
      .select('id, label, url, tool_id, cached_tools')
      .order('created_at', { ascending: true })
    const rows = (srv ?? []) as Omit<McpServer, 'is_active'>[]
    const toolIds = rows.map((r) => r.tool_id).filter((id): id is string => Boolean(id))
    const active = new Map<string, boolean>()
    if (toolIds.length) {
      const { data: tools } = await supabase.from('tools').select('id, is_active').in('id', toolIds)
      for (const t of tools ?? []) active.set(t.id, t.is_active)
    }
    setServers(rows.map((r) => ({ ...r, is_active: r.tool_id ? (active.get(r.tool_id) ?? false) : false })))
    setLoading(false)
  }, [])

  useEffect(() => {
    load()
  }, [load])

  async function toggleActive(s: McpServer) {
    if (!s.tool_id) return
    await supabase.from('tools').update({ is_active: !s.is_active }).eq('id', s.tool_id)
    load()
  }

  // Validate one server server-side (reads its Vault token, runs the MCP
  // handshake + tools/list) and cache its toolset.
  async function connect(id: string) {
    setResults((r) => ({ ...r, [id]: { ok: false, message: 'Connecting…' } }))
    const { data, error: invokeErr } = await supabase.functions.invoke('mcp-admin', { body: { server_id: id } })
    if (invokeErr) {
      const ctx = (invokeErr as { context?: Response }).context
      let message = invokeErr.message
      try {
        if (ctx) message = (await ctx.json())?.message ?? message
      } catch {
        // keep the generic message
      }
      setResults((r) => ({ ...r, [id]: { ok: false, message } }))
      return
    }
    setResults((r) => ({
      ...r,
      [id]: {
        ok: !!data?.ok,
        message: data?.ok
          ? `Connected — ${data.count} tool${data.count === 1 ? '' : 's'} available.`
          : data?.message ?? 'Failed.',
        tools: data?.tools,
      },
    }))
    load()
  }

  async function remove(s: McpServer) {
    if (!confirm(`Remove the MCP server "${s.label}"? Agents will lose its tools.`)) return
    await supabase.rpc('delete_mcp_server', { p_id: s.id })
    load()
  }

  return (
    <section className="mt-6 rounded-xl border border-border bg-surface p-5">
      <h2 className="text-sm font-semibold text-text">External MCP servers</h2>
      <p className="mt-1 text-sm text-muted">
        Connect MCP endpoints — e.g.{' '}
        <a href="https://mcp.zapier.com" target="_blank" rel="noreferrer" className="text-primary underline">
          Zapier MCP
        </a>{' '}
        in front of Gmail, Calendar, and more. Each server's tools become callable by chat and your
        agents. Tokens are stored in Supabase Vault, never in the browser.
      </p>

      {loading ? (
        <p className="mt-4 text-sm text-faint">Loading…</p>
      ) : (
        <div className="mt-4 space-y-3">
          {servers.map((s) =>
            editing === s.id ? (
              <McpServerForm
                key={s.id}
                server={s}
                onDone={() => {
                  setEditing(null)
                  load()
                }}
                onCancel={() => setEditing(null)}
              />
            ) : (
              <div key={s.id} className="rounded-lg border border-border bg-surface-2 p-3">
                <div className="flex items-center gap-3">
                  <button
                    onClick={() => toggleActive(s)}
                    title={s.is_active ? 'Enabled' : 'Disabled'}
                    className={`relative h-5 w-9 shrink-0 rounded-full transition ${s.is_active ? 'bg-primary' : 'bg-border-strong'}`}
                  >
                    <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-surface transition ${s.is_active ? 'left-[18px]' : 'left-0.5'}`} />
                  </button>
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-mono text-sm font-medium text-text">{s.label}</p>
                    <p className="truncate text-xs text-muted">
                      {(s.cached_tools ?? []).length} tools · {s.url}
                    </p>
                  </div>
                  <button onClick={() => connect(s.id)} className="shrink-0 rounded-lg border border-border-strong px-2.5 py-1 text-xs font-semibold text-text transition hover:bg-surface">
                    Connect &amp; list
                  </button>
                  <button onClick={() => setEditing(s.id)} className="shrink-0 rounded-lg px-2 py-1 text-xs text-muted transition hover:text-text">
                    Edit
                  </button>
                  <button onClick={() => remove(s)} className="shrink-0 rounded-lg px-2 py-1 text-xs text-red-600 transition hover:text-red-700">
                    Remove
                  </button>
                </div>
                {results[s.id] && (
                  <div className={`mt-2 rounded-md border px-2.5 py-1.5 text-xs ${results[s.id].ok ? 'border-green-200 bg-green-50 text-green-800' : 'border-red-200 bg-red-50 text-red-700'}`}>
                    <p>{results[s.id].message}</p>
                    {results[s.id].tools && results[s.id].tools!.length > 0 && (
                      <p className="mt-1 text-muted">{results[s.id].tools!.join(', ')}</p>
                    )}
                  </div>
                )}
              </div>
            ),
          )}

          {editing === 'new' ? (
            <McpServerForm
              onDone={() => {
                setEditing(null)
                load()
              }}
              onCancel={() => setEditing(null)}
            />
          ) : (
            <button
              onClick={() => setEditing('new')}
              className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white transition hover:bg-primary-strong"
            >
              Add MCP server
            </button>
          )}
        </div>
      )}
    </section>
  )
}

// Add/edit form for a single MCP server. The token is write-only: on edit, an
// empty token keeps the existing one.
function McpServerForm({ server, onDone, onCancel }: { server?: McpServer; onDone: () => void; onCancel: () => void }) {
  const [label, setLabel] = useState(server?.label ?? '')
  const [url, setUrl] = useState(server?.url ?? '')
  const [token, setToken] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function save() {
    setError(null)
    if (!url.trim()) {
      setError('An MCP endpoint URL is required.')
      return
    }
    if (!server && !token.trim()) {
      setError('A bearer token is required to add a server.')
      return
    }
    setSaving(true)
    const { error: rpcError } = await supabase.rpc('set_mcp_server', {
      p_id: server?.id ?? null,
      p_label: label.trim() || 'mcp',
      p_url: url.trim(),
      p_token: token.trim() || '', // empty = keep existing token (on edit)
    })
    setSaving(false)
    if (rpcError) {
      setError(rpcError.message)
      return
    }
    onDone()
  }

  return (
    <div className="space-y-3 rounded-lg border border-border-strong bg-surface-2 p-3">
      <label className="block">
        <span className="mb-1 block text-xs font-medium text-muted">Label</span>
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="zapier"
          className="w-full rounded-lg border border-border-strong px-3 py-2 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary-soft"
        />
        <span className="mt-1 block text-xs text-faint">
          Namespaces this server's tools (e.g. <code>zapier__gmail_find_email</code>).
        </span>
      </label>
      <label className="block">
        <span className="mb-1 block text-xs font-medium text-muted">Endpoint URL</span>
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://mcp.zapier.com/api/v1/connect"
          className="w-full rounded-lg border border-border-strong px-3 py-2 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary-soft"
        />
      </label>
      <label className="block">
        <span className="mb-1 block text-xs font-medium text-muted">
          Bearer token {server && <span className="text-faint">(leave blank to keep current)</span>}
        </span>
        <input
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder={server ? '••••••••' : 'Paste the MCP server token'}
          className="w-full rounded-lg border border-border-strong px-3 py-2 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary-soft"
        />
      </label>
      {error && <p className="text-sm text-red-600">{error}</p>}
      <div className="flex items-center gap-2">
        <button
          onClick={save}
          disabled={saving}
          className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white transition hover:bg-primary-strong disabled:opacity-60"
        >
          {saving ? 'Saving…' : server ? 'Update server' : 'Add server'}
        </button>
        <button onClick={onCancel} className="rounded-lg px-3 py-2 text-sm text-muted transition hover:text-text">
          Cancel
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

export function EmailCard() {
  const { user } = useAuth()
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
  const [testTo, setTestTo] = useState('')
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null)

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

  // Fires the real send_email path through the email-test edge function, so a
  // success here proves Vault key + provider are wired up (not just saved).
  async function sendTest() {
    const to = (testTo.trim() || user?.email || '').trim()
    if (!to) {
      setTestResult({ ok: false, message: 'Enter a recipient address.' })
      return
    }
    setTesting(true)
    setTestResult(null)
    const { data, error: invokeErr } = await supabase.functions.invoke('email-test', { body: { to } })
    setTesting(false)
    if (invokeErr) {
      // Edge function returns a JSON body with `message` even on non-2xx.
      const ctx = (invokeErr as { context?: Response }).context
      let message = invokeErr.message
      try {
        if (ctx) message = (await ctx.json())?.message ?? message
      } catch {
        // keep the generic message
      }
      setTestResult({ ok: false, message })
      return
    }
    setTestResult({ ok: !!data?.ok, message: data?.message ?? 'Sent.' })
  }

  return (
    <section className="mt-6 rounded-xl border border-border bg-surface p-5">
      <h2 className="text-sm font-semibold text-text">Email</h2>
      <p className="mt-1 text-sm text-muted">
        Configure email once and any user or agent can send and check mail —{' '}
        <em>“email me a summary every morning.”</em> The API key is stored in Supabase Vault, never in
        the browser.
      </p>

      {loading ? (
        <p className="mt-4 text-sm text-faint">Loading…</p>
      ) : (
        <div className="mt-4 space-y-4">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted">Provider</span>
            <select
              value={provider}
              onChange={(e) => setProvider(e.target.value as 'postmark' | 'resend')}
              className="w-full rounded-lg border border-border-strong px-3 py-2 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary-soft"
            >
              <option value="postmark">Postmark</option>
              <option value="resend">Resend</option>
            </select>
          </label>

          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted">From address</span>
            <input
              value={fromAddress}
              onChange={(e) => setFromAddress(e.target.value)}
              placeholder="intranet@yourdomain.com"
              className="w-full rounded-lg border border-border-strong px-3 py-2 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary-soft"
            />
          </label>

          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted">
              API key {existing && <span className="text-faint">— leave blank to keep the current key</span>}
            </span>
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              autoComplete="off"
              placeholder={existing ? '••• configured' : 'Provider API key'}
              className="w-full rounded-lg border border-border-strong px-3 py-2 font-mono text-xs outline-none focus:border-primary focus:ring-2 focus:ring-primary-soft"
            />
          </label>

          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted">
              Allowed recipients <span className="text-faint">— optional, one per line</span>
            </span>
            <textarea
              value={recipients}
              onChange={(e) => setRecipients(e.target.value)}
              rows={2}
              placeholder={'@yourcompany.com\nalerts@partner.com'}
              className="w-full resize-y rounded-lg border border-border-strong px-3 py-2 font-mono text-xs outline-none focus:border-primary focus:ring-2 focus:ring-primary-soft"
            />
            <span className="mt-1 block text-[11px] text-faint">
              Blank = send anywhere. Use exact addresses or <code>@domain.com</code> suffixes to limit where mail can go.
            </span>
          </label>

          {error && <p className="text-xs text-red-600">{error}</p>}

          <button
            onClick={save}
            disabled={saving}
            className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white hover:bg-primary-strong disabled:opacity-60"
          >
            {saving ? 'Saving…' : saved ? 'Saved!' : existing ? 'Update email' : 'Set up email'}
          </button>

          {existing && (
            <div className="mt-2 rounded-lg border border-border bg-surface-2 p-3">
              <p className="text-xs font-medium text-muted">Send a test email</p>
              <p className="mt-1 text-[11px] text-muted">
                Runs the real <code>send_email</code> path (reads the Vault key, calls{' '}
                {existing.provider === 'resend' ? 'Resend' : 'Postmark'}, logs to Activity) to prove sending works.
              </p>
              <div className="mt-2 flex flex-col gap-2 sm:flex-row">
                <input
                  type="email"
                  value={testTo}
                  onChange={(e) => setTestTo(e.target.value)}
                  placeholder={user?.email ?? 'you@example.com'}
                  className="min-w-0 flex-1 rounded-lg border border-border-strong px-3 py-2 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary-soft"
                />
                <button
                  onClick={sendTest}
                  disabled={testing}
                  className="shrink-0 rounded-lg border border-border-strong bg-surface px-4 py-2 text-sm font-semibold text-text hover:bg-surface-hover disabled:opacity-60"
                >
                  {testing ? 'Sending…' : 'Send test'}
                </button>
              </div>
              {testResult && (
                <p className={`mt-2 text-xs ${testResult.ok ? 'text-green-700' : 'text-red-600'}`}>
                  {testResult.message}
                </p>
              )}
            </div>
          )}

          {existing?.inbound_token && (
            <div className="mt-2 rounded-lg border border-border bg-surface-2 p-3">
              <p className="text-xs font-medium text-muted">Receiving email</p>
              <p className="mt-1 text-[11px] text-muted">
                Point a <strong>dedicated</strong> address at this inbound endpoint (not a personal mailbox) —
                everything sent to it becomes readable by <code>check_email</code>.
              </p>
              <div className="mt-2 flex items-start gap-2">
                <pre className="min-w-0 flex-1 overflow-x-auto rounded-lg bg-slate-900 p-2 text-[11px] leading-relaxed text-slate-100">
                  {emailInboundUrl(existing.inbound_token)}
                </pre>
                <button
                  onClick={copyInbound}
                  className="shrink-0 rounded-lg border border-border-strong bg-surface px-2 py-1.5 text-xs font-medium text-muted hover:bg-surface-hover"
                >
                  {copied ? 'Copied' : 'Copy'}
                </button>
              </div>
              <ul className="mt-2 space-y-1 text-[11px] text-muted">
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

// TODO: Remove this old function - it's replaced by ConnectClaudeCard.tsx (exported above)
// @ts-expect-error - old function kept temporarily for reference, will be removed
function ConnectClaudeOld() {
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
    <section className="mt-6 rounded-xl border border-border bg-surface p-5">
      <h2 className="text-sm font-semibold text-text">Connect Claude (MCP)</h2>
      <p className="mt-1 text-sm text-muted">
        Connect <strong>Claude Code</strong> (the CLI) to this workspace, then say
        “build an agent that does X on my intranet” and Claude pushes it here — it shows up under
        Agents, Tools, and Webhooks. Generate a token below and run the one-line command it gives you.
      </p>

      <div className="mt-3 flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded-lg bg-surface-2 px-3 py-2 text-xs text-text">
          {mcpUrl}
        </code>
        <button
          onClick={() => copy(mcpUrl, 'url')}
          className="flex shrink-0 items-center gap-1 rounded-lg border border-border-strong px-2.5 py-2 text-xs font-medium text-muted hover:bg-surface-hover"
        >
          <CopyIcon className="h-3.5 w-3.5" /> {copied === 'url' ? 'Copied' : 'Copy'}
        </button>
      </div>

      <div className="mt-4">
        <button
          onClick={generate}
          className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-sm font-semibold text-white hover:bg-primary-strong"
        >
          <PlusIcon className="h-4 w-4" /> New connection token
        </button>
      </div>

      <div className="mt-3 space-y-3">
        {tokens.map((t) => {
          const cmd = `claude mcp add --scope user --transport http intranet ${mcpUrl} --header "Authorization: Bearer ${t.token}"`
          return (
            <div key={t.id} className="rounded-lg border border-border p-3">
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium text-muted">
                  {t.name} · {t.last_used_at ? `last used ${formatDate(t.last_used_at)}` : 'never used'}
                </span>
                <button
                  onClick={() => revoke(t.id)}
                  className="ml-auto rounded-md p-1 text-faint hover:bg-red-50 hover:text-red-600"
                  title="Revoke"
                >
                  <TrashIcon className="h-4 w-4" />
                </button>
              </div>

              <p className="mt-2 text-xs font-medium text-muted">
                1. Run this in your terminal (anywhere — <code className="rounded bg-surface-2 px-1">--scope user</code>{' '}
                makes it available in every project):
              </p>
              <div className="mt-1 flex items-start gap-2">
                <pre className="min-w-0 flex-1 overflow-x-auto rounded-lg bg-slate-900 p-2 text-[11px] leading-relaxed text-slate-100">
                  {cmd}
                </pre>
                <button
                  onClick={() => copy(cmd, t.id)}
                  className="shrink-0 rounded-lg border border-border-strong px-2 py-1.5 text-xs font-medium text-muted hover:bg-surface-hover"
                >
                  {copied === t.id ? 'Copied' : 'Copy'}
                </button>
              </div>

              <p className="mt-2 text-xs text-muted">
                2. Start <code className="rounded bg-surface-2 px-1">claude</code> and run{' '}
                <code className="rounded bg-surface-2 px-1">/mcp</code> — you should see{' '}
                <strong>intranet</strong> connected. Then ask it to “list my intranet agents” to confirm.
              </p>
              <p className="mt-1 text-[11px] text-faint">
                Treat this token like a password — anyone with it can act as you here. Revoke it (🗑) if it leaks.
              </p>
            </div>
          )
        })}
        {tokens.length === 0 && (
          <p className="text-xs text-faint">No connection tokens yet.</p>
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

export function InvitePeople() {
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
    <section className="mt-6 rounded-xl border border-border bg-surface p-5">
      <h2 className="text-sm font-semibold text-text">Invite people</h2>
      <p className="mt-1 text-sm text-muted">
        This workspace is invite-only. Add an email here, then the person can sign up with it
        at your app’s login page.
      </p>

      <form onSubmit={add} className="mt-4 flex gap-2">
        <input
          type="email"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="teammate@company.com"
          className="min-w-0 flex-1 rounded-lg border border-border-strong px-3 py-2 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary-soft"
        />
        <button
          type="submit"
          disabled={busy}
          className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-sm font-semibold text-white transition hover:bg-primary-strong disabled:opacity-60"
        >
          <PlusIcon className="h-4 w-4" /> Invite
        </button>
      </form>
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}

      <div className="mt-4 divide-y divide-slate-100 overflow-hidden rounded-lg border border-border">
        {emails.length === 0 ? (
          <p className="px-3 py-4 text-center text-sm text-faint">No invites yet.</p>
        ) : (
          emails.map((e) => (
            <div key={e.email} className="flex items-center gap-3 px-3 py-2">
              <span className="min-w-0 flex-1 truncate text-sm text-text">{e.email}</span>
              <span className="text-xs text-faint">{formatDate(e.created_at)}</span>
              <button
                onClick={() => remove(e.email)}
                title="Remove invite"
                className="rounded-md p-1.5 text-faint hover:bg-red-50 hover:text-red-600"
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

// Slack bot (admin-only): invite the app to a channel, bind that channel to
// collections (+ optionally an agent), and @mentions get answered with that
// room's context. Credentials are write-only — they live in Supabase Vault,
// written through the set_slack_integration RPC, never read back here.
type SlackBinding = Database['public']['Tables']['slack_channel_bindings']['Row']

export function SlackCard() {
  const { user } = useAuth()
  const [configured, setConfigured] = useState(false)
  const [teamName, setTeamName] = useState('')
  const [botToken, setBotToken] = useState('')
  const [signingSecret, setSigningSecret] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [copiedManifest, setCopiedManifest] = useState(false)

  const [bindings, setBindings] = useState<SlackBinding[]>([])
  const [collections, setCollections] = useState<{ id: string; name: string }[]>([])
  const [agents, setAgents] = useState<{ id: string; name: string }[]>([])
  const [showAdd, setShowAdd] = useState(false)
  const [channelId, setChannelId] = useState('')
  const [channelName, setChannelName] = useState('')
  const [picked, setPicked] = useState<string[]>([])
  const [agentId, setAgentId] = useState('')
  const [allowTools, setAllowTools] = useState(false)
  const [ambient, setAmbient] = useState(false)
  const [participationPrompt, setParticipationPrompt] = useState('')
  const [gateModel, setGateModel] = useState('')
  const [captureMessages, setCaptureMessages] = useState(true)
  const [adding, setAdding] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)

  const load = useCallback(async () => {
    const [integ, binds, colls, ags] = await Promise.all([
      supabase.from('slack_integration').select('team_name').maybeSingle(),
      supabase.from('slack_channel_bindings').select('*').order('created_at', { ascending: true }),
      supabase.from('collections').select('id, name').order('name'),
      supabase.from('agents').select('id, name').order('name'),
    ])
    setConfigured(Boolean(integ.data))
    setTeamName(integ.data?.team_name ?? '')
    setBindings(binds.data ?? [])
    setCollections((colls.data ?? []) as { id: string; name: string }[])
    setAgents((ags.data ?? []) as { id: string; name: string }[])
    setLoading(false)
  }, [])

  useEffect(() => {
    load()
  }, [load])

  async function saveConfig() {
    setError(null)
    if (!configured && (!botToken.trim() || !signingSecret.trim())) {
      setError('A bot token and signing secret are required to set up Slack.')
      return
    }
    setSaving(true)
    const { error: rpcError } = await supabase.rpc('set_slack_integration', {
      p_bot_token: botToken.trim(), // empty = keep existing
      p_signing_secret: signingSecret.trim(),
      p_team_name: teamName.trim() || null,
    })
    setSaving(false)
    if (rpcError) {
      setError(rpcError.message)
      return
    }
    setBotToken('')
    setSigningSecret('')
    setSaved(true)
    setTimeout(() => setSaved(false), 1500)
    load()
  }

  async function disconnect() {
    if (!confirm('Remove the Slack integration? Channel bindings are kept but stop answering.')) return
    const { error: rpcError } = await supabase.rpc('delete_slack_integration')
    if (rpcError) setError(rpcError.message)
    load()
  }

  async function copyUrl() {
    await navigator.clipboard.writeText(slackEventsUrl)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  // Paste-ready app manifest: creating the Slack app "From a manifest" sets the
  // name, scopes, events, and this workspace's Request URL in one step.
  const appManifest = `display_information:
  name: Workspace Assistant
  description: Answers with the room's collection context.
features:
  bot_user:
    display_name: assistant
    always_online: true
oauth_config:
  scopes:
    bot:
      - app_mentions:read
      - chat:write
      - channels:history
      - groups:history
      - users:read
settings:
  event_subscriptions:
    request_url: ${slackEventsUrl}
    bot_events:
      - app_mention
      - message.channels
      - message.groups
  org_deploy_enabled: false
  socket_mode_enabled: false
  token_rotation_enabled: false
`

  async function copyManifest() {
    await navigator.clipboard.writeText(appManifest)
    setCopiedManifest(true)
    setTimeout(() => setCopiedManifest(false), 1500)
  }

  // Link straight to their Slack when the workspace-name field looks usable
  // ("acme" or "acme.slack.com" both work).
  const workspaceHost = teamName.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '')
  const workspaceUrl = workspaceHost
    ? `https://${workspaceHost.includes('.') ? workspaceHost : `${workspaceHost}.slack.com`}`
    : null

  function resetForm() {
    setChannelId('')
    setChannelName('')
    setPicked([])
    setAgentId('')
    setAllowTools(false)
    setAmbient(false)
    setParticipationPrompt('')
    setGateModel('')
    setCaptureMessages(true)
    setEditingId(null)
    setError(null)
  }

  function startEdit(b: SlackBinding) {
    const f = bindingToForm(b)
    setChannelId(f.channelId)
    setChannelName(f.channelName)
    setPicked(f.collectionIds)
    setAgentId(f.agentId)
    setAllowTools(f.allowTools)
    setAmbient(f.ambient)
    setParticipationPrompt(f.participationPrompt)
    setGateModel(f.gateModel)
    setCaptureMessages(f.captureMessages)
    setEditingId(b.id)
    setError(null)
    setShowAdd(true)
  }

  // Toggle the form open/closed; clears any in-progress edit so "Bind a channel"
  // always starts fresh.
  function toggleForm() {
    if (showAdd) {
      resetForm()
      setShowAdd(false)
    } else {
      resetForm()
      setShowAdd(true)
    }
  }

  // Create a new binding or, when editingId is set, update the existing one —
  // both share buildSlackBindingPayload so create/edit stay in lockstep.
  async function saveBinding() {
    setError(null)
    if (!user) return
    const built = buildSlackBindingPayload({
      channelId,
      channelName,
      collectionIds: picked,
      agentId,
      allowTools,
      ambient,
      participationPrompt,
      gateModel,
      captureMessages,
    })
    if (!built.ok) {
      setError(built.error)
      return
    }
    setAdding(true)
    const { error: saveErr } = editingId
      ? await supabase.from('slack_channel_bindings').update(built.payload).eq('id', editingId)
      : await supabase.from('slack_channel_bindings').insert({ ...built.payload, owner_id: user.id })
    setAdding(false)
    if (saveErr) {
      setError(saveErr.message)
      return
    }
    resetForm()
    setShowAdd(false)
    load()
  }

  async function toggleBinding(b: SlackBinding) {
    await supabase.from('slack_channel_bindings').update({ is_active: !b.is_active }).eq('id', b.id)
    load()
  }

  async function removeBinding(b: SlackBinding) {
    if (!confirm(`Unlink #${b.channel_name || b.channel_id}?`)) return
    await supabase.from('slack_channel_bindings').delete().eq('id', b.id)
    load()
  }

  const collectionName = (id: string) => collections.find((c) => c.id === id)?.name ?? '…'

  return (
    <section className="mt-6 rounded-xl border border-border bg-surface p-5">
      <h2 className="text-sm font-semibold text-text">Slack</h2>
      <p className="mt-1 text-sm text-muted">
        Add the workspace bot to Slack rooms and bind each room to collections — @mention it and it
        answers with that room's docs, files, to-dos and links. Turn on <strong>ambient mode</strong> for a
        channel to have it read every message and decide when to chime in on its own. Credentials are stored
        in Supabase Vault, never in the browser.
      </p>

      {loading ? (
        <p className="mt-4 text-sm text-faint">Loading…</p>
      ) : (
        <div className="mt-4 space-y-4">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted">Workspace name <span className="text-faint">— optional label</span></span>
            <input
              value={teamName}
              onChange={(e) => setTeamName(e.target.value)}
              placeholder="acme.slack.com"
              className="w-full rounded-lg border border-border-strong px-3 py-2 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary-soft"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted">
              Bot token {configured && <span className="text-faint">— leave blank to keep the current one</span>}
            </span>
            <input
              type="password"
              value={botToken}
              onChange={(e) => setBotToken(e.target.value)}
              autoComplete="off"
              placeholder={configured ? '••• configured' : 'xoxb-…'}
              className="w-full rounded-lg border border-border-strong px-3 py-2 font-mono text-xs outline-none focus:border-primary focus:ring-2 focus:ring-primary-soft"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted">
              Signing secret {configured && <span className="text-faint">— leave blank to keep the current one</span>}
            </span>
            <input
              type="password"
              value={signingSecret}
              onChange={(e) => setSigningSecret(e.target.value)}
              autoComplete="off"
              placeholder={configured ? '••• configured' : 'From the Slack app’s Basic Information page'}
              className="w-full rounded-lg border border-border-strong px-3 py-2 font-mono text-xs outline-none focus:border-primary focus:ring-2 focus:ring-primary-soft"
            />
          </label>

          {error && <p className="text-xs text-red-600">{error}</p>}

          <div className="flex items-center gap-3">
            <button
              onClick={saveConfig}
              disabled={saving}
              className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white hover:bg-primary-strong disabled:opacity-60"
            >
              {saving ? 'Saving…' : saved ? 'Saved!' : configured ? 'Update Slack' : 'Connect Slack'}
            </button>
            {configured && (
              <button onClick={disconnect} className="text-xs font-medium text-red-600 hover:underline">
                Remove
              </button>
            )}
          </div>

          <div className="mt-2 rounded-lg border border-border bg-surface-2 p-3">
            <p className="text-xs font-medium text-muted">Setup guide — about 5 minutes</p>
            <ol className="mt-2 list-decimal space-y-2 pl-4 text-[11px] leading-relaxed text-muted">
              <li>
                Go to{' '}
                <a
                  href="https://api.slack.com/apps"
                  target="_blank"
                  rel="noreferrer"
                  className="font-medium text-primary underline"
                >
                  api.slack.com/apps
                </a>{' '}
                → <em>Create New App</em> → <em>From a manifest</em> → pick your workspace and paste
                the manifest:{' '}
                <button
                  onClick={copyManifest}
                  className="rounded border border-border-strong bg-surface px-1.5 py-0.5 text-[11px] font-medium text-muted hover:bg-surface-hover"
                >
                  {copiedManifest ? 'Copied!' : 'Copy app manifest'}
                </button>{' '}
                — it pre-fills the bot's name, permissions, and this workspace's event URL, so
                there's nothing to configure by hand.
              </li>
              <li>
                Click <em>Install to Workspace</em> (under <em>OAuth &amp; Permissions</em> in the
                left sidebar), then copy the <strong>Bot User OAuth Token</strong> — it starts with{' '}
                <code>xoxb-</code> — into the field above.
              </li>
              <li>
                Copy the <strong>Signing Secret</strong> from <em>Basic Information</em> →{' '}
                <em>App Credentials</em> (click <em>Show</em>) into the field above, and hit{' '}
                <em>{configured ? 'Update Slack' : 'Connect Slack'}</em>.
              </li>
              <li>
                Back in the Slack app config, open <em>Event Subscriptions</em> and confirm the
                Request URL shows <strong>Verified</strong>. (Save the credentials here first —
                verification is signed with them. If it shows failed, click <em>Retry</em>.)
              </li>
              <li>
                In{' '}
                {workspaceUrl ? (
                  <a
                    href={workspaceUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="font-medium text-primary underline"
                  >
                    your Slack workspace
                  </a>
                ) : (
                  'your Slack workspace'
                )}
                , type <code>/invite @assistant</code> in the room you want it in, then bind that
                room to collections below.
              </li>
            </ol>
            <p className="mt-3 text-xs font-medium text-muted">Event subscriptions URL (step 4)</p>
            <div className="mt-1.5 flex items-start gap-2">
              <pre className="min-w-0 flex-1 overflow-x-auto rounded-lg bg-slate-900 p-2 text-[11px] leading-relaxed text-slate-100">
                {slackEventsUrl}
              </pre>
              <button
                onClick={copyUrl}
                className="shrink-0 rounded-lg border border-border-strong bg-surface px-2 py-1.5 text-xs font-medium text-muted hover:bg-surface-hover"
              >
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
          </div>

          {configured && (
            <div className="mt-2 rounded-lg border border-border bg-surface-2 p-3">
              <div className="flex items-center justify-between">
                <p className="text-xs font-medium text-muted">Channel bindings</p>
                <button
                  onClick={toggleForm}
                  className="flex items-center gap-1 rounded-lg border border-border-strong bg-surface px-2 py-1 text-xs font-medium text-muted hover:bg-surface-hover"
                >
                  <PlusIcon className="h-3.5 w-3.5" /> {showAdd ? 'Cancel' : 'Bind a channel'}
                </button>
              </div>
              <p className="mt-1 text-[11px] text-muted">
                A binding runs as the admin who creates it — bind <strong>workspace</strong>-visibility
                collections for team rooms so answers only draw on what everyone can already see.
              </p>

              {showAdd && (
                <div className="mt-3 space-y-3 rounded-lg border border-border bg-surface p-3">
                  {editingId && (
                    <p className="text-xs font-medium text-muted">
                      Editing #{channelName || channelId} — update its collections, agent, mode or
                      settings.
                    </p>
                  )}
                  <div className="grid gap-3 sm:grid-cols-2">
                    <label className="block">
                      <span className="mb-1 block text-xs font-medium text-muted">Channel ID</span>
                      <input
                        value={channelId}
                        onChange={(e) => setChannelId(e.target.value)}
                        placeholder="C0123ABCDEF"
                        className="w-full rounded-lg border border-border-strong px-3 py-2 font-mono text-xs outline-none focus:border-primary focus:ring-2 focus:ring-primary-soft"
                      />
                      <span className="mt-1 block text-[11px] text-faint">
                        In Slack: click the channel name → <em>About</em> tab → Channel ID is at the
                        bottom (starts with C).
                      </span>
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-xs font-medium text-muted">Channel name</span>
                      <input
                        value={channelName}
                        onChange={(e) => setChannelName(e.target.value)}
                        placeholder="project-acme"
                        className="w-full rounded-lg border border-border-strong px-3 py-2 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary-soft"
                      />
                    </label>
                  </div>
                  <div>
                    <span className="mb-1 block text-xs font-medium text-muted">Collections this room can use</span>
                    {collections.length === 0 ? (
                      <p className="text-[11px] text-faint">No collections yet — create one on the Artifacts page.</p>
                    ) : (
                      <div className="flex flex-wrap gap-2">
                        {collections.map((c) => {
                          const on = picked.includes(c.id)
                          return (
                            <button
                              key={c.id}
                              onClick={() =>
                                setPicked((p) => (on ? p.filter((x) => x !== c.id) : [...p, c.id]))
                              }
                              className={`rounded-full border px-3 py-1 text-xs font-medium transition ${
                                on
                                  ? 'border-primary bg-primary-soft text-primary'
                                  : 'border-border-strong bg-surface text-muted hover:bg-surface-hover'
                              }`}
                            >
                              {c.name}
                            </button>
                          )
                        })}
                      </div>
                    )}
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <label className="block">
                      <span className="mb-1 block text-xs font-medium text-muted">Agent <span className="text-faint">— optional</span></span>
                      <select
                        value={agentId}
                        onChange={(e) => setAgentId(e.target.value)}
                        className="w-full rounded-lg border border-border-strong px-3 py-2 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary-soft"
                      >
                        <option value="">None — plain assistant</option>
                        {agents.map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="mt-5 flex items-center gap-2 text-sm text-muted">
                      <input
                        type="checkbox"
                        checked={allowTools}
                        onChange={(e) => setAllowTools(e.target.checked)}
                        className="h-4 w-4 rounded border-border-strong"
                      />
                      Allow the agent's tools
                    </label>
                  </div>

                  {/* Ambient participation (Claude-Tag style) */}
                  <div className="rounded-lg border border-border bg-surface-2 p-3">
                    <label className="flex items-center gap-2 text-sm font-medium text-text">
                      <input
                        type="checkbox"
                        checked={ambient}
                        onChange={(e) => setAmbient(e.target.checked)}
                        className="h-4 w-4 rounded border-border-strong"
                      />
                      Ambient mode — listen to every message and decide when to chime in
                    </label>
                    <p className="mt-1 text-[11px] text-faint">
                      Off (default): the bot only replies when @mentioned. On: it reads all channel messages and a
                      cheap model decides whether to jump in, guided by your prompt below.
                    </p>
                    {ambient && (
                      <div className="mt-3 space-y-3">
                        <div className="rounded-lg border border-amber-300/60 bg-amber-50/80 p-3 dark:border-amber-500/40 dark:bg-amber-500/10">
                          <p className="text-xs font-semibold text-amber-800 dark:text-amber-300">
                            One-time Slack app change required
                          </p>
                          <p className="mt-1 text-[11px] leading-relaxed text-amber-800/90 dark:text-amber-200/90">
                            Ambient mode only works if Slack sends the bot <em>every</em> channel message — by
                            default it only sends @mentions. In{' '}
                            <a
                              href="https://api.slack.com/apps"
                              target="_blank"
                              rel="noreferrer"
                              className="font-medium underline"
                            >
                              api.slack.com/apps
                            </a>{' '}
                            → your app → <em>Event Subscriptions</em> → <em>Subscribe to bot events</em> →{' '}
                            <em>Add Bot User Event</em>: add <code>message.channels</code> (public channels; add{' '}
                            <code>message.groups</code> too for private ones) and hit <em>Save Changes</em>. No
                            reinstall needed — these events use the history scopes the bot already has, and they
                            start flowing as soon as you save. Apps created from the current manifest (
                            <em>Copy app manifest</em> above) already include them.
                          </p>
                        </div>
                        <label className="block">
                          <span className="mb-1 block text-xs font-medium text-muted">
                            When should it chime in? <span className="text-faint">— channel guidance</span>
                          </span>
                          <textarea
                            value={participationPrompt}
                            onChange={(e) => setParticipationPrompt(e.target.value)}
                            rows={3}
                            placeholder="e.g. Jump in when someone asks a product or billing question, or seems stuck. Stay quiet for banter, greetings, and side chatter."
                            className="w-full rounded-lg border border-border-strong px-3 py-2 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary-soft"
                          />
                        </label>
                        <div className="grid gap-3 sm:grid-cols-2">
                          <label className="block">
                            <span className="mb-1 block text-xs font-medium text-muted">
                              Decision model <span className="text-faint">— optional OpenRouter slug</span>
                            </span>
                            <input
                              value={gateModel}
                              onChange={(e) => setGateModel(e.target.value)}
                              placeholder="anthropic/claude-haiku-4.5"
                              className="w-full rounded-lg border border-border-strong px-3 py-2 font-mono text-xs outline-none focus:border-primary focus:ring-2 focus:ring-primary-soft"
                            />
                            <span className="mt-1 block text-[11px] text-faint">
                              Runs the "should I reply?" check. Blank uses the workspace utility model (cheap).
                            </span>
                          </label>
                          <label className="mt-5 flex items-center gap-2 text-sm text-muted">
                            <input
                              type="checkbox"
                              checked={captureMessages}
                              onChange={(e) => setCaptureMessages(e.target.checked)}
                              className="h-4 w-4 rounded border-border-strong"
                            />
                            Save messages to the Inbox
                          </label>
                        </div>
                      </div>
                    )}
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      onClick={saveBinding}
                      disabled={adding}
                      className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white hover:bg-primary-strong disabled:opacity-60"
                    >
                      {adding
                        ? editingId
                          ? 'Saving…'
                          : 'Binding…'
                        : editingId
                          ? 'Save changes'
                          : 'Bind channel'}
                    </button>
                    <button
                      onClick={toggleForm}
                      className="rounded-lg border border-border-strong px-4 py-2 text-sm font-medium text-muted hover:bg-surface-hover"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}

              {bindings.length === 0 && !showAdd ? (
                <p className="mt-3 text-[11px] text-faint">No channels bound yet.</p>
              ) : (
                <ul className="mt-3 space-y-2">
                  {bindings.map((b) => (
                    <li key={b.id} className="rounded-lg border border-border bg-surface p-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-semibold text-text">#{b.channel_name || b.channel_id}</span>
                        <span className="font-mono text-[10px] text-faint">{b.channel_id}</span>
                        {!b.is_active && (
                          <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[10px] font-medium text-faint">paused</span>
                        )}
                        {b.allow_tools && (
                          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-700">tools on</span>
                        )}
                        {b.mode === 'ambient' && (
                          <span className="rounded-full bg-primary-soft px-2 py-0.5 text-[10px] font-medium text-primary">ambient</span>
                        )}
                        <span className="ml-auto flex items-center gap-2">
                          <button
                            onClick={() => startEdit(b)}
                            className="text-xs font-medium text-muted hover:underline"
                          >
                            Edit
                          </button>
                          <button
                            onClick={() => toggleBinding(b)}
                            className="text-xs font-medium text-muted hover:underline"
                          >
                            {b.is_active ? 'Pause' : 'Resume'}
                          </button>
                          <button onClick={() => removeBinding(b)} className="text-faint hover:text-red-600">
                            <TrashIcon className="h-4 w-4" />
                          </button>
                        </span>
                      </div>
                      <div className="mt-1.5 flex flex-wrap gap-1.5">
                        {(b.collection_ids ?? []).map((id) => (
                          <span key={id} className="rounded-full bg-primary-soft px-2 py-0.5 text-[10px] font-medium text-primary">
                            {collectionName(id)}
                          </span>
                        ))}
                        {b.agent_id && (
                          <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[10px] font-medium text-muted">
                            agent: {agents.find((a) => a.id === b.agent_id)?.name ?? '…'}
                          </span>
                        )}
                        {(b.collection_ids ?? []).length === 0 && !b.agent_id && (
                          <span className="text-[10px] text-faint">no collections bound — answers without room context</span>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  )
}
