import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import type { Database } from '../lib/database.types'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import { formatDate } from '../lib/util'
import { BoltIcon, InboxIcon, MailIcon, PlusIcon, TrashIcon } from '../components/icons'

type Account = Database['public']['Tables']['email_accounts']['Row']

// Common provider presets — pick one to fill host/port/secure. The user still
// supplies an app password (see docs/events-and-inbox.md).
const PRESETS: Record<string, { host: string; port: number; secure: boolean }> = {
  'Gmail / Google Workspace': { host: 'imap.gmail.com', port: 993, secure: true },
  'Outlook / Microsoft 365': { host: 'outlook.office365.com', port: 993, secure: true },
  Yahoo: { host: 'imap.mail.yahoo.com', port: 993, secure: true },
  iCloud: { host: 'imap.mail.me.com', port: 993, secure: true },
  Fastmail: { host: 'imap.fastmail.com', port: 993, secure: true },
}

export default function InboxAccountsPage() {
  const { user } = useAuth()
  const [accounts, setAccounts] = useState<Account[]>([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<Account | 'new' | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  // Insert a synthetic email into the inbox (source=email) so message.received
  // fires — lets you wire + verify a Listener without waiting for real mail.
  async function sendMock(a: Account) {
    setNotice(null)
    const { error } = await supabase.from('inbox_messages').insert({
      owner_id: user?.id ?? a.owner_id,
      source: 'email',
      external_id: `mock:${crypto.randomUUID()}`,
      from_address: a.username,
      from_name: 'IMAP Test',
      to_address: a.username,
      subject: `Test message from ${a.label || a.username}`,
      body_text:
        'This is a mock email inserted to test the inbox → message.received → listener pipeline. It did not come from a real mailbox.',
      visibility: a.visibility,
      raw: { provider: 'mock', account_id: a.id },
    })
    setNotice(
      error
        ? `Could not create test message: ${error.message}`
        : 'Test message added to the Inbox — it fired a message.received event, so any matching Listener runs now.',
    )
  }

  const load = useCallback(async () => {
    const { data } = await supabase
      .from('email_accounts')
      .select('*')
      .order('created_at', { ascending: true })
    setAccounts(data ?? [])
    setLoading(false)
  }, [])

  useEffect(() => {
    load()
  }, [load])

  // Realtime: the poller updates last_checked_at / last_error on the row.
  useEffect(() => {
    const channel = supabase
      .channel('email-accounts')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'email_accounts' }, () => load())
      .subscribe()
    return () => {
      supabase.removeChannel(channel)
    }
  }, [load])

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl px-6 py-8">
        <div className="mb-1 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Link to="/inbox" className="text-sm text-muted hover:text-text">
              Inbox
            </Link>
            <span className="text-faint">/</span>
            <h1 className="text-2xl font-semibold tracking-tight text-text">Inboxes</h1>
          </div>
          <button
            onClick={() => setEditing('new')}
            className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white hover:bg-primary-strong"
          >
            <PlusIcon className="h-4 w-4" /> Add inbox
          </button>
        </div>
        <p className="mb-6 text-sm text-muted">
          Connect an IMAP mailbox and the workspace polls it for new mail — each message lands in
          your <Link to="/inbox" className="underline">Inbox</Link> and fires a{' '}
          <code className="rounded bg-surface-2 px-1">message.received</code> event, so you can route
          it from <Link to="/listeners" className="underline">Listeners</Link> (e.g. into a table)
          just like a webhook. Use an <strong>app password</strong>, not your login password — most
          providers require one once 2FA is on.
        </p>

        {notice && (
          <div className="mb-4 flex items-start justify-between gap-3 rounded-lg border border-border bg-surface-2 px-4 py-3 text-sm text-text">
            <span>{notice}</span>
            <button onClick={() => setNotice(null)} className="shrink-0 text-faint hover:text-text">
              ✕
            </button>
          </div>
        )}

        {loading ? (
          <p className="text-sm text-faint">Loading…</p>
        ) : accounts.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border px-6 py-10 text-center text-sm text-faint">
            No inboxes yet. Add an IMAP mailbox to pull email into the workspace.
          </p>
        ) : (
          <div className="space-y-3">
            {accounts.map((a) => (
              <div key={a.id} className="flex items-center gap-3 rounded-xl border border-border bg-surface p-4">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-muted">
                  <MailIcon className="h-5 w-5" />
                </div>
                <button onClick={() => setEditing(a)} className="min-w-0 flex-1 text-left">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-sm font-medium text-text">
                      {a.label || a.username}
                    </span>
                    <span
                      className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                        a.visibility === 'workspace'
                          ? 'bg-emerald-100 text-emerald-700'
                          : 'bg-surface-2 text-muted'
                      }`}
                    >
                      {a.visibility}
                    </span>
                    {!a.active && (
                      <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[10px] font-medium text-faint">
                        paused
                      </span>
                    )}
                    {a.last_error && (
                      <span className="rounded-full bg-red-100 px-2 py-0.5 text-[10px] font-medium text-red-700">
                        error
                      </span>
                    )}
                  </div>
                  <p className="mt-0.5 line-clamp-1 font-mono text-xs text-muted">
                    {a.username} · {a.host}:{a.port}
                  </p>
                  <p className="mt-0.5 line-clamp-1 text-xs text-faint">
                    {a.last_error
                      ? a.last_error
                      : a.last_checked_at
                        ? `Last checked ${formatDate(a.last_checked_at)} · every ${a.poll_interval_minutes} min`
                        : `Not checked yet · every ${a.poll_interval_minutes} min`}
                  </p>
                </button>
                <button
                  onClick={() => sendMock(a)}
                  className="flex shrink-0 items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium text-muted transition hover:bg-surface-hover hover:text-text"
                  title="Insert a mock email to fire a message.received event"
                >
                  <BoltIcon className="h-3.5 w-3.5" /> Test message
                </button>
              </div>
            ))}
          </div>
        )}

        <p className="mt-8 flex items-center gap-2 text-xs text-faint">
          <InboxIcon className="h-4 w-4" /> Workspace inboxes are visible to the whole team; private
          ones only to you.
        </p>
      </div>

      {editing && (
        <AccountEditor
          account={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null)
            load()
          }}
        />
      )}
    </div>
  )
}

function AccountEditor({
  account,
  onClose,
  onSaved,
}: {
  account: Account | null
  onClose: () => void
  onSaved: () => void
}) {
  const { user } = useAuth()
  const [label, setLabel] = useState(account?.label ?? '')
  const [host, setHost] = useState(account?.host ?? '')
  const [port, setPort] = useState(account?.port ?? 993)
  const [secure, setSecure] = useState(account?.secure ?? true)
  const [username, setUsername] = useState(account?.username ?? '')
  const [password, setPassword] = useState('')
  const [folder, setFolder] = useState(account?.folder ?? 'INBOX')
  const [interval, setIntervalMin] = useState(account?.poll_interval_minutes ?? 5)
  const [visibility, setVisibility] = useState<'private' | 'workspace'>(
    (account?.visibility as 'private' | 'workspace') ?? 'private',
  )
  const [active, setActive] = useState(account?.active ?? true)
  const [markSeen, setMarkSeen] = useState(account?.mark_seen ?? true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(null)
  const [rescanning, setRescanning] = useState(false)

  // "When mail arrives here → do X" — one managed per-inbox listener.
  type TableRow = { id: string; name: string; columns: { key: string; label?: string }[] }
  const [tables, setTables] = useState<TableRow[]>([])
  const [agentList, setAgentList] = useState<{ id: string; name: string }[]>([])
  const [toolList, setToolList] = useState<{ id: string; name: string }[]>([])
  const [routeAction, setRouteAction] = useState<'none' | 'table' | 'agent' | 'function'>('none')
  const [routeTable, setRouteTable] = useState('') // table name
  const [colFrom, setColFrom] = useState('')
  const [colSubject, setColSubject] = useState('')
  const [colBody, setColBody] = useState('')
  const [colReceived, setColReceived] = useState('')
  const [routeAgent, setRouteAgent] = useState('')
  const [routeTool, setRouteTool] = useState('') // tool name

  useEffect(() => {
    supabase.from('user_tables').select('id, name, columns').order('name').then(({ data }) =>
      setTables(((data ?? []) as unknown as TableRow[]).map((t) => ({ ...t, columns: t.columns ?? [] }))),
    )
    supabase.from('agents').select('id, name').eq('is_active', true).order('name').then(({ data }) =>
      setAgentList((data as { id: string; name: string }[]) ?? []),
    )
    supabase.from('tools').select('id, name, kind').eq('is_active', true).order('name').then(({ data }) =>
      setToolList(((data ?? []) as { id: string; name: string; kind: string }[]).filter((t) => t.kind === 'http')),
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Prefill the routing UI from the account's managed listener, if any.
  useEffect(() => {
    if (!account?.routing_listener_id) return
    supabase
      .from('event_listeners')
      .select('action_type, action_config')
      .eq('id', account.routing_listener_id)
      .maybeSingle()
      .then(({ data }) => {
        if (!data) return
        const cfg = (data.action_config ?? {}) as {
          tool?: string
          agent_id?: string
          input?: { table?: string; values?: Record<string, string> }
        }
        if (data.action_type === 'run_agent') {
          setRouteAction('agent')
          setRouteAgent(cfg.agent_id ?? '')
        } else if (data.action_type === 'run_tool' && cfg.tool === 'add_table_row') {
          setRouteAction('table')
          setRouteTable(cfg.input?.table ?? '')
          for (const [col, tok] of Object.entries(cfg.input?.values ?? {})) {
            const f = /event\.data\.(\w+)/.exec(tok || '')?.[1]
            if (f === 'from_address') setColFrom(col)
            else if (f === 'subject') setColSubject(col)
            else if (f === 'body') setColBody(col)
            else if (f === 'received_at') setColReceived(col)
          }
        } else if (data.action_type === 'run_tool') {
          setRouteAction('function')
          setRouteTool(cfg.tool ?? '')
        }
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account?.routing_listener_id])

  async function rescan() {
    if (!account) return
    setError(null)
    setTestResult(null)
    setRescanning(true)
    const { error: rpcError } = await supabase.rpc('reset_email_account_cursor', { p_account_id: account.id })
    setRescanning(false)
    setTestResult(
      rpcError
        ? { ok: false, msg: rpcError.message }
        : { ok: true, msg: 'Cursor reset — the next poll (within ~1 min) re-imports the most recent mail.' },
    )
  }

  async function testConnection() {
    setError(null)
    setTestResult(null)
    if (!host.trim() || !username.trim()) {
      setError('Host and username are required to test.')
      return
    }
    if (!account && !password.trim()) {
      setError('Enter the app password to test a new inbox.')
      return
    }
    setTesting(true)
    const { data, error: fnError } = await supabase.functions.invoke('imap-test', {
      body: {
        account_id: account?.id ?? null,
        host: host.trim(),
        port: Number(port) || 993,
        secure,
        username: username.trim(),
        password: password.trim() || undefined, // omitted → server reads the saved one from Vault
        folder: folder.trim() || 'INBOX',
      },
    })
    setTesting(false)
    const result = (data ?? {}) as { ok?: boolean; message?: string; error?: string }
    if (fnError) {
      setTestResult({ ok: false, msg: fnError.message })
    } else if (result.ok) {
      setTestResult({ ok: true, msg: result.message ?? 'Connected.' })
    } else {
      setTestResult({ ok: false, msg: result.error ?? 'Connection failed.' })
    }
  }

  function applyPreset(name: string) {
    const p = PRESETS[name]
    if (!p) return
    setHost(p.host)
    setPort(p.port)
    setSecure(p.secure)
  }

  async function save() {
    setError(null)
    if (!host.trim() || !username.trim()) {
      setError('Host and username are required.')
      return
    }
    if (!account && !password.trim()) {
      setError('A password (app password) is required to add an inbox.')
      return
    }
    setSaving(true)
    const { data: newId, error: rpcError } = await supabase.rpc('set_email_account', {
      p_id: account?.id ?? null,
      p_label: label.trim(),
      p_host: host.trim(),
      p_port: Number(port) || 993,
      p_secure: secure,
      p_username: username.trim(),
      p_password: password.trim() || '', // empty = keep existing (on edit)
      p_folder: folder.trim() || 'INBOX',
      p_visibility: visibility,
      p_poll_interval_minutes: Number(interval) || 5,
      p_active: active,
      p_mark_seen: markSeen,
    })
    if (rpcError) {
      setSaving(false)
      setError(rpcError.message)
      return
    }
    const accountId = (newId as string) ?? account?.id
    if (accountId) await saveRouting(accountId)
    setSaving(false)
    setPassword('')
    onSaved()
  }

  // Create / update / detach the ONE per-inbox listener that routes new mail.
  // A deterministic run_tool (add_table_row) or run_agent / run function, scoped
  // to this inbox via match.account_id (0104). The message still lands in the Inbox.
  async function saveRouting(accountId: string) {
    const existing = account?.routing_listener_id ?? null
    if (routeAction === 'none') {
      if (existing) await supabase.from('event_listeners').delete().eq('id', existing)
      await supabase.rpc('set_email_account_routing', { p_account_id: accountId, p_listener_id: null })
      return
    }
    const base = {
      name: `Inbox: ${label.trim() || username.trim()}`,
      event_type: 'message.received',
      match: { account_id: accountId },
      is_active: true,
      visibility,
    }
    let action_type: string
    let action_config: Record<string, unknown>
    if (routeAction === 'table') {
      const values: Record<string, string> = {}
      if (colFrom) values[colFrom] = '{{event.data.from_address}}'
      if (colSubject) values[colSubject] = '{{event.data.subject}}'
      if (colBody) values[colBody] = '{{event.data.body}}'
      if (colReceived) values[colReceived] = '{{event.data.received_at}}'
      action_type = 'run_tool'
      action_config = { tool: 'add_table_row', input: { table: routeTable, values } }
    } else if (routeAction === 'agent') {
      action_type = 'run_agent'
      action_config = { agent_id: routeAgent }
    } else {
      action_type = 'run_tool'
      action_config = {
        tool: routeTool,
        input: {
          source: '{{event.data.source}}',
          from_address: '{{event.data.from_address}}',
          subject: '{{event.data.subject}}',
          body: '{{event.data.body}}',
          received_at: '{{event.data.received_at}}',
          account_id: '{{event.data.account_id}}',
        },
      }
    }
    const row = { ...base, action_type, action_config } as never
    let listenerId = existing
    if (listenerId) {
      await supabase.from('event_listeners').update(row).eq('id', listenerId)
    } else {
      const { data: ins } = await supabase
        .from('event_listeners')
        .insert({ ...(row as object), owner_id: user?.id } as never)
        .select('id')
        .single()
      listenerId = (ins as { id: string } | null)?.id ?? null
    }
    if (listenerId) await supabase.rpc('set_email_account_routing', { p_account_id: accountId, p_listener_id: listenerId })
  }

  async function remove() {
    if (!account) return
    if (!confirm(`Remove inbox “${account.label || account.username}”? Polling stops immediately.`)) return
    await supabase.rpc('delete_email_account', { p_id: account.id })
    onSaved()
  }

  const field =
    'w-full rounded-lg border border-border-strong px-3 py-2 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary-soft'

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/40 sm:items-center sm:p-4">
      <div className="flex max-h-[92vh] w-full max-w-lg flex-col overflow-hidden rounded-t-2xl bg-surface shadow-xl sm:rounded-2xl">
        <div className="flex items-center justify-between border-b border-border px-5 py-3">
          <h2 className="text-sm font-semibold text-text">{account ? 'Edit inbox' : 'Add inbox'}</h2>
          {account && (
            <button
              onClick={remove}
              className="rounded-md p-1.5 text-faint hover:bg-red-50 hover:text-red-600"
              title="Remove"
            >
              <TrashIcon className="h-[18px] w-[18px]" />
            </button>
          )}
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto p-5">
          {!account && (
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-muted">Quick fill from a provider</span>
              <select className={field} defaultValue="" onChange={(e) => applyPreset(e.target.value)}>
                <option value="">Choose a provider…</option>
                {Object.keys(PRESETS).map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted">Name (optional)</span>
            <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Monitoring inbox" className={field} />
          </label>
          <div className="grid grid-cols-3 gap-3">
            <label className="col-span-2 block">
              <span className="mb-1 block text-xs font-medium text-muted">IMAP host</span>
              <input value={host} onChange={(e) => setHost(e.target.value)} placeholder="imap.gmail.com" className={`${field} font-mono`} />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-muted">Port</span>
              <input
                type="number"
                value={port}
                onChange={(e) => setPort(Number(e.target.value))}
                className={`${field} font-mono`}
              />
            </label>
          </div>
          <label className="flex items-center gap-2 text-sm text-muted">
            <input type="checkbox" checked={secure} onChange={(e) => setSecure(e.target.checked)} />
            Use SSL/TLS (port 993 — recommended)
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted">Username (usually the full email)</span>
            <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="monitoring@yourdomain.com" className={`${field} font-mono`} />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted">
              {account ? 'App password (leave blank to keep the current one)' : 'App password'}
            </span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={account ? '••••••••  (unchanged)' : 'app-specific password'}
              autoComplete="off"
              className={`${field} font-mono`}
            />
            <span className="mt-1 block text-[11px] text-faint">
              Stored encrypted in Supabase Vault. Generate one in your provider's 2FA / security
              settings (Gmail → App passwords).
            </span>
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-muted">Folder</span>
              <input value={folder} onChange={(e) => setFolder(e.target.value)} className={`${field} font-mono`} />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-muted">Check every (minutes)</span>
              <input
                type="number"
                min={1}
                max={1440}
                value={interval}
                onChange={(e) => setIntervalMin(Number(e.target.value))}
                className={`${field} font-mono`}
              />
            </label>
          </div>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted">Sharing</span>
            <select value={visibility} onChange={(e) => setVisibility(e.target.value as 'private' | 'workspace')} className={field}>
              <option value="private">Private — mail visible only to me</option>
              <option value="workspace">Workspace — mail shared with the team</option>
            </select>
          </label>
          <label className="flex items-center gap-2 text-sm text-muted">
            <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
            Active (polling on)
          </label>
          <label className="flex items-center gap-2 text-sm text-muted">
            <input type="checkbox" checked={markSeen} onChange={(e) => setMarkSeen(e.target.checked)} />
            Mark messages read on the server after importing
          </label>

          <div className="space-y-3 rounded-lg border border-border bg-surface-2/40 p-3">
            <span className="block text-xs font-medium text-muted">When new mail arrives here</span>
            <select
              value={routeAction}
              onChange={(e) => setRouteAction(e.target.value as typeof routeAction)}
              className={field}
            >
              <option value="none">Just add it to the Inbox</option>
              <option value="table">Also save it to a table</option>
              <option value="agent">Also run an agent</option>
              <option value="function">Also run a function</option>
            </select>

            {routeAction === 'table' && (
              <div className="space-y-2">
                <select value={routeTable} onChange={(e) => setRouteTable(e.target.value)} className={field}>
                  <option value="">Choose a table…</option>
                  {tables.map((t) => (
                    <option key={t.id} value={t.name}>
                      {t.name}
                    </option>
                  ))}
                </select>
                {routeTable &&
                  (() => {
                    const cols = tables.find((t) => t.name === routeTable)?.columns ?? []
                    const colSelect = (val: string, set: (v: string) => void, lbl: string) => (
                      <label className="block">
                        <span className="mb-1 block text-[11px] text-faint">{lbl} →</span>
                        <select value={val} onChange={(e) => set(e.target.value)} className={field}>
                          <option value="">— skip —</option>
                          {cols.map((c) => (
                            <option key={c.key} value={c.key}>
                              {c.label || c.key}
                            </option>
                          ))}
                        </select>
                      </label>
                    )
                    return (
                      <div className="grid grid-cols-2 gap-2">
                        {colSelect(colFrom, setColFrom, 'From')}
                        {colSelect(colSubject, setColSubject, 'Subject')}
                        {colSelect(colBody, setColBody, 'Body')}
                        {colSelect(colReceived, setColReceived, 'Received')}
                      </div>
                    )
                  })()}
              </div>
            )}

            {routeAction === 'agent' && (
              <select value={routeAgent} onChange={(e) => setRouteAgent(e.target.value)} className={field}>
                <option value="">Choose an agent…</option>
                {agentList.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            )}

            {routeAction === 'function' && (
              <select value={routeTool} onChange={(e) => setRouteTool(e.target.value)} className={field}>
                <option value="">Choose a function…</option>
                {toolList.map((t) => (
                  <option key={t.id} value={t.name}>
                    {t.name}
                  </option>
                ))}
              </select>
            )}

            <p className="text-[11px] text-faint">
              Runs deterministically through a per-inbox rule on the{' '}
              <Link to="/listeners" className="underline">Listeners</Link> page — no AI needed for “save to a
              table.” The message still lands in your Inbox either way.
            </p>
          </div>

          {testResult && (
            <p className={`text-sm ${testResult.ok ? 'text-emerald-600' : 'text-red-600'}`}>
              {testResult.ok ? '✓ ' : '✗ '}
              {testResult.msg}
            </p>
          )}
          {error && <p className="text-sm text-red-600">{error}</p>}
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-border px-5 py-3">
          <div className="flex gap-2">
            <button
              onClick={testConnection}
              disabled={testing || !host.trim() || !username.trim()}
              className="rounded-lg border border-border px-3 py-2 text-sm font-medium text-muted hover:bg-surface-hover hover:text-text disabled:opacity-50"
            >
              {testing ? 'Testing…' : 'Test connection'}
            </button>
            {account && (
              <button
                onClick={rescan}
                disabled={rescanning}
                className="rounded-lg border border-border px-3 py-2 text-sm font-medium text-muted hover:bg-surface-hover hover:text-text disabled:opacity-50"
                title="Reset the cursor so the next poll re-imports recent mail"
              >
                {rescanning ? 'Resetting…' : 'Re-scan'}
              </button>
            )}
          </div>
          <div className="flex gap-2">
            <button onClick={onClose} className="rounded-lg px-3 py-2 text-sm font-medium text-muted hover:bg-surface-hover">
              Cancel
            </button>
            <button
              onClick={save}
              disabled={saving || !host.trim() || !username.trim()}
              className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white hover:bg-primary-strong disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
