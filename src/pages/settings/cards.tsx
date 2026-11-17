import { useCallback, useEffect, useState } from 'react'
import type { Database } from '../../lib/database.types'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../contexts/AuthContext'
import { CheckIcon, DownloadIcon } from '../../components/icons'
import { clearDismissed, isStandalone } from '../../lib/pwa'

export { ConnectClaude } from './ConnectClaudeCard'

// The Settings cards live here so the per-area Settings pages
// (src/pages/settings/*.tsx) can each render one. They were split out of the
// old single SettingsPage when Settings became a sidebar section (issue #122).

type ModelProfile = Database['public']['Tables']['model_profiles']['Row']

// Your profile — email (read-only) + display name + avatar.
export function ProfileCard() {
  const { user } = useAuth()
  const [displayName, setDisplayName] = useState('')
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    if (!user) return
    supabase
      .from('profiles')
      .select('display_name, avatar_url')
      .eq('id', user.id)
      .maybeSingle()
      .then(({ data }) => {
        setDisplayName(data?.display_name ?? '')
        setAvatarUrl(data?.avatar_url ?? null)
      })
  }, [user])

  async function uploadAvatar(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file || !user) return

    // Validate file type
    if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type)) {
      alert('Please upload a PNG, JPEG, WebP, or GIF image.')
      return
    }

    // Validate file size (2MB)
    if (file.size > 2 * 1024 * 1024) {
      alert('Image must be smaller than 2MB.')
      return
    }

    setUploading(true)
    try {
      // Delete old avatar if it exists
      if (avatarUrl) {
        const oldPath = avatarUrl.split('/').slice(-2).join('/')
        await supabase.storage.from('avatars').remove([oldPath])
      }

      // Upload new avatar
      const ext = file.name.split('.').pop()
      const fileName = `avatar-${Date.now()}.${ext}`
      const filePath = `${user.id}/${fileName}`

      const { error: uploadError } = await supabase.storage
        .from('avatars')
        .upload(filePath, file, { upsert: true })

      if (uploadError) throw uploadError

      // Get public URL
      const { data: { publicUrl } } = supabase.storage
        .from('avatars')
        .getPublicUrl(filePath)

      setAvatarUrl(publicUrl)
    } catch (error) {
      console.error('Error uploading avatar:', error)
      alert('Failed to upload avatar. Please try again.')
    } finally {
      setUploading(false)
    }
  }

  async function removeAvatar() {
    if (!user || !avatarUrl) return

    setUploading(true)
    try {
      // Delete from storage
      const oldPath = avatarUrl.split('/').slice(-2).join('/')
      await supabase.storage.from('avatars').remove([oldPath])

      // Update profile
      await supabase
        .from('profiles')
        .update({ avatar_url: null, updated_at: new Date().toISOString() })
        .eq('id', user.id)

      setAvatarUrl(null)
    } catch (error) {
      console.error('Error removing avatar:', error)
      alert('Failed to remove avatar. Please try again.')
    } finally {
      setUploading(false)
    }
  }

  async function save() {
    if (!user) return
    setSaving(true)
    await supabase
      .from('profiles')
      .upsert({
        id: user.id,
        email: user.email,
        display_name: displayName,
        avatar_url: avatarUrl,
        updated_at: new Date().toISOString()
      })
    setSaving(false)
    setSaved(true)
    setTimeout(() => setSaved(false), 1500)
  }

  const initial = (user?.email ?? '?').charAt(0).toUpperCase()

  return (
    <section className="mt-6 rounded-xl border border-border bg-surface p-5">
      <h2 className="text-sm font-semibold text-text">Profile</h2>
      <div className="mt-4 space-y-4">
        <div>
          <span className="mb-2 block text-xs font-medium text-muted">Avatar</span>
          <div className="flex items-center gap-4">
            <div className="relative h-20 w-20 shrink-0 overflow-hidden rounded-full">
              {avatarUrl ? (
                <img src={avatarUrl} alt="Avatar" className="h-full w-full object-cover" />
              ) : (
                <div className="flex h-full w-full items-center justify-center bg-primary-soft text-2xl font-bold text-primary">
                  {initial}
                </div>
              )}
            </div>
            <div className="flex flex-col gap-2">
              <label className="cursor-pointer rounded-lg border border-border-strong bg-surface-2 px-4 py-2 text-sm font-medium text-text transition hover:bg-surface-hover">
                {uploading ? 'Uploading…' : avatarUrl ? 'Change avatar' : 'Upload avatar'}
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/gif"
                  onChange={uploadAvatar}
                  disabled={uploading}
                  className="hidden"
                />
              </label>
              {avatarUrl && (
                <button
                  onClick={removeAvatar}
                  disabled={uploading}
                  className="rounded-lg border border-border-strong px-4 py-2 text-sm font-medium text-muted transition hover:border-red-500 hover:text-red-600 disabled:opacity-60"
                >
                  Remove avatar
                </button>
              )}
              <p className="text-xs text-muted">PNG, JPEG, WebP, or GIF. Max 2MB.</p>
            </div>
          </div>
        </div>
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

// Password — set or update it. Magic-link-only users have no password until they
// set one here; a password is what the Claude connector's OAuth sign-in uses.
// Setting it also stamps user_metadata.has_password so other pages (Connect Claude)
// can tell it's configured.
export function PasswordCard() {
  const { user } = useAuth()
  const hasPassword = Boolean(user?.user_metadata?.has_password)
  const [pw, setPw] = useState('')
  const [confirm, setConfirm] = useState('')
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  async function save() {
    setMsg(null)
    if (pw.length < 8) return setMsg({ ok: false, text: 'Use at least 8 characters.' })
    if (pw !== confirm) return setMsg({ ok: false, text: 'Passwords do not match.' })
    setSaving(true)
    const { error } = await supabase.auth.updateUser({ password: pw, data: { has_password: true } })
    setSaving(false)
    if (error) return setMsg({ ok: false, text: error.message })
    setPw('')
    setConfirm('')
    setMsg({ ok: true, text: 'Password set — you can now sign in with it, including the Claude connector.' })
  }

  return (
    <section className="mt-4 rounded-xl border border-border bg-surface p-5">
      <h2 className="text-sm font-semibold text-text">Password</h2>
      <p className="mt-1 text-sm text-muted">
        {hasPassword
          ? 'You have a password set. Use it to sign in, or update it below.'
          : "You sign in with magic links and don't have a password yet. Set one to sign in with email + password — needed to approve the Claude connector (OAuth)."}
      </p>
      <div className="mt-4 max-w-sm space-y-4">
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-muted">{hasPassword ? 'New password' : 'Password'}</span>
          <input
            type="password"
            autoComplete="new-password"
            value={pw}
            onChange={(e) => setPw(e.target.value)}
            className="w-full rounded-lg border border-border-strong px-3 py-2 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary-soft"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-muted">Confirm password</span>
          <input
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            className="w-full rounded-lg border border-border-strong px-3 py-2 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary-soft"
          />
        </label>
        {msg && <p className={`text-xs ${msg.ok ? 'text-green-600' : 'text-red-600'}`}>{msg.text}</p>}
        <button
          onClick={save}
          disabled={saving || !pw}
          className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white transition hover:bg-primary-strong disabled:opacity-60"
        >
          {saving ? 'Saving…' : hasPassword ? 'Update password' : 'Set password'}
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

// Install app as PWA — shows installation status and a button to trigger the
// install prompt after it's been dismissed.
export function InstallAppCard() {
  const [installed, setInstalled] = useState(false)
  const [canInstall, setCanInstall] = useState(false)
  const [triggered, setTriggered] = useState(false)

  useEffect(() => {
    setInstalled(isStandalone())
    // Check if the browser has already captured the beforeinstallprompt event
    // (we can't directly check this, but if we're not standalone, the browser
    // might support it)
    setCanInstall(!isStandalone())
  }, [])

  function handleShowInstall() {
    clearDismissed()
    setTriggered(true)
    setTimeout(() => setTriggered(false), 2000)
  }

  if (installed) {
    return (
      <section className="mt-4 rounded-xl border border-border bg-surface p-5">
        <h2 className="text-sm font-semibold text-text">Install app</h2>
        <div className="mt-3 flex items-center gap-3 rounded-lg border border-primary/20 bg-primary-soft/30 p-3">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary text-white">
            <CheckIcon className="h-5 w-5" />
          </div>
          <p className="text-sm text-text">
            <strong>Already installed</strong> — you're running as a standalone app.
          </p>
        </div>
      </section>
    )
  }

  if (!canInstall) {
    return null
  }

  return (
    <section className="mt-4 rounded-xl border border-border bg-surface p-5">
      <h2 className="text-sm font-semibold text-text">Install app</h2>
      <p className="mt-2 text-sm text-muted">
        Install this workspace as an app on your device for quick access and a full-screen
        experience. Dismissed the install prompt? Bring it back here.
      </p>
      <button
        onClick={handleShowInstall}
        className="mt-4 flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white transition hover:bg-primary-strong"
      >
        <DownloadIcon className="h-4 w-4" />
        {triggered ? 'Install prompt shown' : 'Show install prompt'}
      </button>
      {triggered && (
        <p className="mt-2 text-xs text-muted">
          Look for the install notification at the bottom-right of the page.
        </p>
      )}
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
