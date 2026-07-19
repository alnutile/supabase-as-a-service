import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { SettingsShell } from './shell'

// IMAP account connectors (any member). Connect a real mailbox (Gmail app
// password, Fastmail, a work IMAP server) and the cron-ticked `imap-poll` edge
// function pulls new mail into the unified inbox. The password is write-only: it
// lives in Supabase Vault, written through `set_imap_account`; the row only ever
// exposes non-secret config, so the browser never holds the credential.
type ImapAccount = {
  id: string
  label: string
  host: string
  port: number
  username: string
  folder: string
  visibility: 'private' | 'workspace'
  mark_seen: boolean
  is_active: boolean
  poll_interval_minutes: number
  last_status: string | null
  last_error: string | null
  last_polled_at: string | null
}

const BLANK_IMAP = {
  id: null as string | null,
  label: '',
  host: '',
  port: 993,
  username: '',
  password: '',
  folder: 'INBOX',
  visibility: 'private' as 'private' | 'workspace',
  mark_seen: true,
  poll_interval_minutes: 5,
}

function ImapCard() {
  const [accounts, setAccounts] = useState<ImapAccount[]>([])
  const [loading, setLoading] = useState(true)
  const [form, setForm] = useState<typeof BLANK_IMAP | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [result, setResult] = useState<{ id: string; ok: boolean; message: string } | null>(null)

  const load = useCallback(async () => {
    const { data } = await supabase
      .from('imap_accounts')
      .select('id, label, host, port, username, folder, visibility, mark_seen, is_active, poll_interval_minutes, last_status, last_error, last_polled_at')
      .order('created_at', { ascending: true })
    setAccounts((data as ImapAccount[]) ?? [])
    setLoading(false)
  }, [])

  useEffect(() => {
    load()
  }, [load])

  function startEdit(a: ImapAccount) {
    setError(null)
    setForm({
      id: a.id,
      label: a.label,
      host: a.host,
      port: a.port,
      username: a.username,
      password: '',
      folder: a.folder,
      visibility: a.visibility,
      mark_seen: a.mark_seen,
      poll_interval_minutes: a.poll_interval_minutes,
    })
  }

  async function save() {
    if (!form) return
    setError(null)
    if (!form.host.trim() || !form.username.trim()) {
      setError('Host and username are required.')
      return
    }
    if (!form.id && !form.password.trim()) {
      setError('A password (or app password) is required.')
      return
    }
    setSaving(true)
    const { error: rpcErr } = await supabase.rpc('set_imap_account', {
      p_id: form.id,
      p_label: form.label.trim(),
      p_host: form.host.trim(),
      p_port: form.port,
      p_username: form.username.trim(),
      p_password: form.password.trim() || '',
      p_folder: form.folder.trim() || 'INBOX',
      p_visibility: form.visibility,
      p_mark_seen: form.mark_seen,
      p_poll_interval_minutes: form.poll_interval_minutes,
    })
    setSaving(false)
    if (rpcErr) {
      setError(rpcErr.message)
      return
    }
    setForm(null)
    load()
  }

  async function pollNow(id: string) {
    setBusy(id)
    setResult(null)
    const { data, error: invokeErr } = await supabase.functions.invoke('imap-poll', { body: { account_id: id } })
    setBusy(null)
    if (invokeErr) {
      const ctx = (invokeErr as { context?: Response }).context
      let message = invokeErr.message
      try {
        if (ctx) message = (await ctx.json())?.message ?? message
      } catch {
        // keep generic
      }
      setResult({ id, ok: false, message })
    } else {
      setResult({ id, ok: !!data?.ok, message: data?.message ?? 'Done.' })
    }
    load()
  }

  async function toggleActive(a: ImapAccount) {
    await supabase.from('imap_accounts').update({ is_active: !a.is_active }).eq('id', a.id)
    load()
  }

  async function remove(id: string) {
    if (!confirm('Remove this mailbox connection? Stored mail stays in your inbox.')) return
    setBusy(id)
    await supabase.rpc('delete_imap_account', { p_id: id })
    setBusy(null)
    load()
  }

  return (
    <section className="rounded-xl border border-border bg-surface p-5">
      <h2 className="text-sm font-semibold text-text">Email accounts (IMAP)</h2>
      <p className="mt-1 text-sm text-muted">
        Connect a real mailbox and new mail is pulled into your{' '}
        <a href="/inbox" className="text-primary underline">Inbox</a> on a schedule. Use a{' '}
        <strong>dedicated address or an app password</strong> (Gmail: enable IMAP, then create an app
        password — <code>imap.gmail.com</code> port <code>993</code>). The password is stored in Supabase Vault,
        never in the browser.
      </p>

      {loading ? (
        <p className="mt-4 text-sm text-faint">Loading…</p>
      ) : (
        <div className="mt-4 space-y-3">
          {accounts.map((a) => (
            <div key={a.id} className="rounded-lg border border-border bg-surface-2 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium text-text">{a.label || a.host}</span>
                <span className="rounded-full bg-surface px-2 py-0.5 text-[10px] font-medium text-muted">
                  {a.visibility === 'workspace' ? 'Shared' : 'Private'}
                </span>
                {!a.is_active && (
                  <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-700">Paused</span>
                )}
                {a.last_status === 'error' && (
                  <span className="rounded-full bg-red-100 px-2 py-0.5 text-[10px] font-medium text-red-700">Error</span>
                )}
                {a.last_status === 'ok' && (
                  <span className="rounded-full bg-green-100 px-2 py-0.5 text-[10px] font-medium text-green-700">OK</span>
                )}
              </div>
              <p className="mt-1 text-[11px] text-muted">
                {a.username} · {a.host}:{a.port} · {a.folder} · every {a.poll_interval_minutes} min
                {a.last_polled_at && <> · last {new Date(a.last_polled_at).toLocaleString()}</>}
              </p>
              {a.last_status === 'error' && a.last_error && (
                <p className="mt-1 text-[11px] text-red-600">{a.last_error}</p>
              )}
              {result?.id === a.id && (
                <p className={`mt-1 text-[11px] ${result.ok ? 'text-green-700' : 'text-red-600'}`}>{result.message}</p>
              )}
              <div className="mt-2 flex flex-wrap gap-2">
                <button
                  onClick={() => pollNow(a.id)}
                  disabled={busy === a.id}
                  className="rounded-lg border border-border-strong bg-surface px-3 py-1 text-xs font-medium text-text hover:bg-surface-hover disabled:opacity-60"
                >
                  {busy === a.id ? 'Polling…' : 'Poll now'}
                </button>
                <button
                  onClick={() => startEdit(a)}
                  className="rounded-lg border border-border-strong bg-surface px-3 py-1 text-xs font-medium text-muted hover:bg-surface-hover"
                >
                  Edit
                </button>
                <button
                  onClick={() => toggleActive(a)}
                  className="rounded-lg border border-border-strong bg-surface px-3 py-1 text-xs font-medium text-muted hover:bg-surface-hover"
                >
                  {a.is_active ? 'Pause' : 'Resume'}
                </button>
                <button
                  onClick={() => remove(a.id)}
                  className="rounded-lg border border-border-strong bg-surface px-3 py-1 text-xs font-medium text-red-600 hover:bg-surface-hover"
                >
                  Remove
                </button>
              </div>
            </div>
          ))}

          {form ? (
            <div className="rounded-lg border border-border bg-surface-2 p-3">
              <p className="text-xs font-medium text-muted">{form.id ? 'Edit account' : 'New account'}</p>
              <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
                <label className="block">
                  <span className="mb-1 block text-xs font-medium text-muted">Label</span>
                  <input
                    value={form.label}
                    onChange={(e) => setForm({ ...form, label: e.target.value })}
                    placeholder="Work Gmail"
                    className="w-full rounded-lg border border-border-strong px-3 py-2 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary-soft"
                  />
                </label>
                <label className="block">
                  <span className="mb-1 block text-xs font-medium text-muted">Folder</span>
                  <input
                    value={form.folder}
                    onChange={(e) => setForm({ ...form, folder: e.target.value })}
                    placeholder="INBOX"
                    className="w-full rounded-lg border border-border-strong px-3 py-2 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary-soft"
                  />
                </label>
                <label className="block">
                  <span className="mb-1 block text-xs font-medium text-muted">Host</span>
                  <input
                    value={form.host}
                    onChange={(e) => setForm({ ...form, host: e.target.value })}
                    placeholder="imap.gmail.com"
                    className="w-full rounded-lg border border-border-strong px-3 py-2 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary-soft"
                  />
                </label>
                <label className="block">
                  <span className="mb-1 block text-xs font-medium text-muted">Port</span>
                  <input
                    type="number"
                    value={form.port}
                    onChange={(e) => setForm({ ...form, port: Number(e.target.value) || 993 })}
                    className="w-full rounded-lg border border-border-strong px-3 py-2 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary-soft"
                  />
                </label>
                <label className="block">
                  <span className="mb-1 block text-xs font-medium text-muted">Username</span>
                  <input
                    value={form.username}
                    onChange={(e) => setForm({ ...form, username: e.target.value })}
                    placeholder="you@gmail.com"
                    autoComplete="off"
                    className="w-full rounded-lg border border-border-strong px-3 py-2 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary-soft"
                  />
                </label>
                <label className="block">
                  <span className="mb-1 block text-xs font-medium text-muted">
                    Password {form.id && <span className="text-faint">— blank keeps current</span>}
                  </span>
                  <input
                    type="password"
                    value={form.password}
                    onChange={(e) => setForm({ ...form, password: e.target.value })}
                    autoComplete="new-password"
                    placeholder={form.id ? '••• configured' : 'App password'}
                    className="w-full rounded-lg border border-border-strong px-3 py-2 font-mono text-xs outline-none focus:border-primary focus:ring-2 focus:ring-primary-soft"
                  />
                </label>
                <label className="block">
                  <span className="mb-1 block text-xs font-medium text-muted">Visibility</span>
                  <select
                    value={form.visibility}
                    onChange={(e) => setForm({ ...form, visibility: e.target.value as 'private' | 'workspace' })}
                    className="w-full rounded-lg border border-border-strong px-3 py-2 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary-soft"
                  >
                    <option value="private">Private (only me)</option>
                    <option value="workspace">Shared with workspace</option>
                  </select>
                </label>
                <label className="block">
                  <span className="mb-1 block text-xs font-medium text-muted">Check every (minutes)</span>
                  <input
                    type="number"
                    min={1}
                    max={1440}
                    value={form.poll_interval_minutes}
                    onChange={(e) => setForm({ ...form, poll_interval_minutes: Math.min(1440, Math.max(1, Number(e.target.value) || 5)) })}
                    className="w-full rounded-lg border border-border-strong px-3 py-2 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary-soft"
                  />
                </label>
              </div>
              <label className="mt-3 flex items-center gap-2 text-xs text-muted">
                <input
                  type="checkbox"
                  checked={form.mark_seen}
                  onChange={(e) => setForm({ ...form, mark_seen: e.target.checked })}
                />
                Mark messages as read on the server after importing
              </label>
              {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
              <div className="mt-3 flex gap-2">
                <button
                  onClick={save}
                  disabled={saving}
                  className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white hover:bg-primary-strong disabled:opacity-60"
                >
                  {saving ? 'Saving…' : form.id ? 'Update account' : 'Connect account'}
                </button>
                <button
                  onClick={() => {
                    setForm(null)
                    setError(null)
                  }}
                  className="rounded-lg border border-border-strong bg-surface px-4 py-2 text-sm font-semibold text-text hover:bg-surface-hover"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button
              onClick={() => {
                setError(null)
                setForm({ ...BLANK_IMAP })
              }}
              className="rounded-lg border border-border-strong bg-surface px-4 py-2 text-sm font-semibold text-text hover:bg-surface-hover"
            >
              + Connect a mailbox
            </button>
          )}
        </div>
      )}
    </section>
  )
}

export default function EmailAccountsSettings() {
  return (
    <SettingsShell title="Email accounts" subtitle="Connect a mailbox over IMAP to pull mail into your inbox.">
      <ImapCard />
    </SettingsShell>
  )
}
