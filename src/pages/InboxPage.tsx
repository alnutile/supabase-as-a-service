import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Database } from '../lib/database.types'
import { useAuth } from '../contexts/AuthContext'
import { supabase } from '../lib/supabase'
import { formatDate } from '../lib/util'
import { Link } from 'react-router-dom'
import { InboxIcon, MailIcon, PlusIcon, TrashIcon, CollectionIcon } from '../components/icons'

type Message = Database['public']['Tables']['inbox_messages']['Row']
type Collection = { id: string; name: string }

const SOURCES = ['email', 'slack', 'whatsapp', 'sms', 'webhook', 'manual', 'other'] as const

const SOURCE_STYLE: Record<string, string> = {
  email: 'bg-sky-100 text-sky-700',
  slack: 'bg-violet-100 text-violet-700',
  whatsapp: 'bg-emerald-100 text-emerald-700',
  sms: 'bg-amber-100 text-amber-700',
  webhook: 'bg-indigo-100 text-indigo-700',
  manual: 'bg-surface-2 text-muted',
  other: 'bg-surface-2 text-muted',
}

function SourceBadge({ source }: { source: string }) {
  return (
    <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${SOURCE_STYLE[source] ?? SOURCE_STYLE.other}`}>
      {source}
    </span>
  )
}

export default function InboxPage() {
  const { user } = useAuth()
  const [messages, setMessages] = useState<Message[]>([])
  const [collections, setCollections] = useState<Collection[]>([])
  const [loading, setLoading] = useState(true)
  const [source, setSource] = useState<string>('all')
  const [unreadOnly, setUnreadOnly] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [composing, setComposing] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    let query = supabase.from('inbox_messages').select('*').order('received_at', { ascending: false }).limit(200)
    if (source !== 'all') query = query.eq('source', source)
    if (unreadOnly) query = query.is('read_at', null)
    const { data } = await query
    setMessages(data ?? [])
    setLoading(false)
  }, [source, unreadOnly])

  useEffect(() => {
    load()
  }, [load])

  useEffect(() => {
    supabase
      .from('collections')
      .select('id, name')
      .order('name', { ascending: true })
      .then(({ data }) => setCollections((data as Collection[]) ?? []))
  }, [])

  useEffect(() => {
    const channel = supabase
      .channel('inbox-messages')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'inbox_messages' }, (payload) => {
        setMessages((prev) => {
          const row = payload.new as Message
          if (prev.some((m) => m.id === row.id)) return prev
          return [row, ...prev].slice(0, 200)
        })
      })
      .subscribe()
    return () => {
      supabase.removeChannel(channel)
    }
  }, [])

  const selected = useMemo(() => messages.find((m) => m.id === selectedId) ?? null, [messages, selectedId])
  const unreadCount = useMemo(() => messages.filter((m) => !m.read_at).length, [messages])

  const open = async (m: Message) => {
    setSelectedId(m.id)
    if (!m.read_at) {
      const now = new Date().toISOString()
      setMessages((prev) => prev.map((x) => (x.id === m.id ? { ...x, read_at: now } : x)))
      await supabase.from('inbox_messages').update({ read_at: now }).eq('id', m.id)
    }
  }

  const toggleRead = async (m: Message) => {
    const next = m.read_at ? null : new Date().toISOString()
    setMessages((prev) => prev.map((x) => (x.id === m.id ? { ...x, read_at: next } : x)))
    await supabase.from('inbox_messages').update({ read_at: next }).eq('id', m.id)
  }

  const remove = async (m: Message) => {
    setMessages((prev) => prev.filter((x) => x.id !== m.id))
    if (selectedId === m.id) setSelectedId(null)
    await supabase.from('inbox_messages').delete().eq('id', m.id)
  }

  const addToCollection = async (m: Message, collectionId: string) => {
    if (!collectionId) return
    await supabase
      .from('collection_inbox_messages')
      .upsert({ collection_id: collectionId, inbox_message_id: m.id, added_by: user?.id ?? null }, {
        onConflict: 'collection_id,inbox_message_id',
        ignoreDuplicates: true,
      })
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="border-b border-border bg-surface px-6 py-4">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight text-text">
              <InboxIcon className="h-6 w-6 text-primary" /> Inbox
              {unreadCount > 0 && (
                <span className="rounded-full bg-primary px-2 py-0.5 text-xs font-bold text-white">{unreadCount}</span>
              )}
            </h1>
            <p className="mt-1 text-sm text-muted">
              One place for every message — email, Slack, WhatsApp, and anything you push in. File them into
              collections to chat over them or trigger automations.
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Link
              to="/inbox/accounts"
              className="flex items-center gap-1.5 rounded-xl border border-border px-3 py-2 text-sm font-semibold text-muted transition hover:bg-surface-hover hover:text-text"
              title="Connect an IMAP mailbox"
            >
              <MailIcon className="h-4 w-4" /> Inboxes
            </Link>
            <button
              onClick={() => setComposing(true)}
              className="flex items-center gap-1.5 rounded-xl bg-primary px-3 py-2 text-sm font-semibold text-white transition hover:bg-primary-strong"
            >
              <PlusIcon className="h-4 w-4" /> New
            </button>
          </div>
        </div>
      </div>

      <div className="border-b border-border bg-surface px-6 py-2">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-1.5">
          {(['all', ...SOURCES] as const).map((s) => (
            <button
              key={s}
              onClick={() => setSource(s)}
              className={`rounded-full px-3 py-1 text-xs font-medium capitalize transition ${
                source === s ? 'bg-slate-900 text-white' : 'bg-surface-2 text-muted hover:bg-surface-hover'
              }`}
            >
              {s}
            </button>
          ))}
          <label className="ml-auto flex cursor-pointer items-center gap-1.5 text-xs font-medium text-muted">
            <input type="checkbox" checked={unreadOnly} onChange={(e) => setUnreadOnly(e.target.checked)} />
            Unread only
          </label>
        </div>
      </div>

      <div className="mx-auto flex min-h-0 w-full max-w-5xl flex-1 overflow-hidden">
        {/* List */}
        <div className={`min-w-0 flex-1 overflow-y-auto ${selected ? 'hidden md:block md:max-w-sm md:border-r md:border-border' : ''}`}>
          {loading ? (
            <p className="p-6 text-sm text-faint">Loading…</p>
          ) : messages.length === 0 ? (
            <div className="m-6 rounded-2xl border border-dashed border-border-strong py-16 text-center">
              <InboxIcon className="mx-auto mb-3 h-8 w-8 text-faint" />
              <p className="text-sm text-muted">No messages yet.</p>
            </div>
          ) : (
            <ul>
              {messages.map((m) => (
                <li key={m.id}>
                  <button
                    onClick={() => open(m)}
                    className={`flex w-full flex-col gap-1 border-b border-border px-4 py-3 text-left transition hover:bg-surface-hover ${
                      selectedId === m.id ? 'bg-primary-soft' : ''
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      {!m.read_at && <span className="h-2 w-2 shrink-0 rounded-full bg-primary" />}
                      <SourceBadge source={m.source} />
                      <span className="min-w-0 flex-1 truncate text-sm font-semibold text-text">
                        {m.from_name || m.from_address || '—'}
                      </span>
                      <span className="shrink-0 text-[11px] text-faint">{formatDate(m.received_at)}</span>
                    </div>
                    <div className="truncate text-sm text-text">{m.subject || '(no subject)'}</div>
                    <div className="truncate text-xs text-muted">{m.body_text}</div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Detail */}
        {selected && (
          <div className="min-w-0 flex-1 overflow-y-auto p-6">
            <button onClick={() => setSelectedId(null)} className="mb-3 text-sm text-primary hover:underline md:hidden">
              ← Back
            </button>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="mb-1 flex items-center gap-2">
                  <SourceBadge source={selected.source} />
                  <span className="text-xs text-faint">{formatDate(selected.received_at)}</span>
                </div>
                <h2 className="text-lg font-semibold text-text">{selected.subject || '(no subject)'}</h2>
                <p className="text-sm text-muted">
                  From <span className="font-medium text-text">{selected.from_name || selected.from_address || '—'}</span>
                  {selected.to_address ? ` · to ${selected.to_address}` : ''}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <button
                  onClick={() => toggleRead(selected)}
                  className="rounded-lg border border-border px-2 py-1 text-xs font-medium text-muted hover:bg-surface-hover"
                >
                  Mark {selected.read_at ? 'unread' : 'read'}
                </button>
                <button
                  onClick={() => remove(selected)}
                  className="rounded-lg border border-border p-1.5 text-faint hover:bg-red-50 hover:text-red-600"
                  title="Delete"
                >
                  <TrashIcon className="h-4 w-4" />
                </button>
              </div>
            </div>

            {selected.url && (
              <a href={selected.url} target="_blank" rel="noreferrer" className="mt-2 inline-block text-sm text-primary hover:underline">
                Open original ↗
              </a>
            )}

            <div className="mt-4 whitespace-pre-wrap rounded-xl border border-border bg-surface p-4 text-sm text-text">
              {selected.body_text || <span className="text-faint">(no content)</span>}
            </div>

            {collections.length > 0 && (
              <div className="mt-4 flex items-center gap-2">
                <CollectionIcon className="h-4 w-4 text-faint" />
                <select
                  defaultValue=""
                  onChange={(e) => {
                    addToCollection(selected, e.target.value)
                    e.target.value = ''
                  }}
                  className="rounded-lg border border-border bg-surface px-2 py-1.5 text-sm text-text"
                >
                  <option value="" disabled>
                    Add to collection…
                  </option>
                  {collections.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>
        )}
      </div>

      {composing && <ComposeModal onClose={() => setComposing(false)} ownerId={user?.id ?? ''} />}
    </div>
  )
}

function ComposeModal({ onClose, ownerId }: { onClose: () => void; ownerId: string }) {
  const [source, setSource] = useState<string>('manual')
  const [from, setFrom] = useState('')
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  const [saving, setSaving] = useState(false)

  const save = async () => {
    if (!body.trim() || !ownerId) return
    setSaving(true)
    await supabase.from('inbox_messages').insert({
      owner_id: ownerId,
      source,
      from_name: from,
      from_address: from,
      subject,
      body_text: body,
      visibility: 'private',
    })
    setSaving(false)
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4" onClick={onClose}>
      <div className="w-full max-w-lg rounded-2xl border border-border bg-surface p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-semibold text-text">New message</h2>
        <p className="mt-0.5 text-sm text-muted">Push a message into your inbox by hand.</p>
        <div className="mt-4 space-y-3">
          <div className="flex gap-3">
            <select
              value={source}
              onChange={(e) => setSource(e.target.value)}
              className="rounded-lg border border-border bg-surface px-2 py-2 text-sm text-text"
            >
              {SOURCES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
            <input
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              placeholder="From (name / email / handle)"
              className="min-w-0 flex-1 rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text"
            />
          </div>
          <input
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder="Subject"
            className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text"
          />
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Message…"
            rows={5}
            className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text"
          />
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-lg px-3 py-2 text-sm font-medium text-muted hover:bg-surface-hover">
            Cancel
          </button>
          <button
            onClick={save}
            disabled={saving || !body.trim()}
            className="rounded-lg bg-primary px-3 py-2 text-sm font-semibold text-white transition hover:bg-primary-strong disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}
