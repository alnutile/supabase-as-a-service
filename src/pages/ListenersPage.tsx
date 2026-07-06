import { useCallback, useEffect, useState } from 'react'
import type { Database, Json } from '../lib/database.types'
import { useAuth } from '../contexts/AuthContext'
import { supabase } from '../lib/supabase'
import { formatDate } from '../lib/util'
import { BoltIcon, PlusIcon, TrashIcon } from '../components/icons'

type Listener = Database['public']['Tables']['event_listeners']['Row']
type ListenerRun = Database['public']['Tables']['event_listener_runs']['Row']
type NamedRow = { id: string; name: string }

// Curated event types the pickers offer (users can also type a custom one).
const EVENT_TYPES = [
  { value: '*', label: 'Any event' },
  { value: 'message.received', label: 'Message received' },
  { value: 'message.*', label: 'Any message event' },
  { value: 'collection.item_added', label: 'Item added to a collection' },
  { value: 'artifact.created', label: 'Artifact created' },
  { value: 'artifact.updated', label: 'Artifact updated' },
  { value: 'artifact.*', label: 'Any artifact event' },
  { value: 'file.created', label: 'File added' },
  { value: 'file.deleted', label: 'File deleted' },
  { value: 'file.*', label: 'Any file event' },
  { value: 'todo.created', label: 'To-do added' },
  { value: 'todo.completed', label: 'To-do completed' },
  { value: 'link.created', label: 'Link saved' },
  { value: 'chat.created', label: 'Conversation started' },
]

const ENTITY_TYPES = ['artifact', 'file', 'todo', 'link', 'message', 'table']
const SOURCES = ['email', 'slack', 'whatsapp', 'sms', 'webhook', 'manual', 'other']

const ACTIONS = [
  { value: 'run_agent', label: 'Run an agent', hint: 'Hand the event to an agent to reason and act.' },
  { value: 'run_tool', label: 'Run a tool', hint: 'Call one tool directly (no model in the loop).' },
  { value: 'add_to_collection', label: 'Add to a collection', hint: "File the event's item into a collection." },
  { value: 'log', label: 'Just log it', hint: 'Record the match only — a safe way to test a rule.' },
]

type Draft = {
  id?: string
  name: string
  event_type: string
  is_active: boolean
  visibility: 'private' | 'workspace'
  match: { entity_type?: string; collection_id?: string; source?: string }
  action_type: string
  action_config: Record<string, unknown>
}

function emptyDraft(): Draft {
  return {
    name: '',
    event_type: 'collection.item_added',
    is_active: true,
    visibility: 'private',
    match: {},
    action_type: 'log',
    action_config: {},
  }
}

function toDraft(l: Listener): Draft {
  return {
    id: l.id,
    name: l.name,
    event_type: l.event_type,
    is_active: l.is_active,
    visibility: (l.visibility as 'private' | 'workspace') ?? 'private',
    match: (l.match as Draft['match']) ?? {},
    action_type: l.action_type,
    action_config: (l.action_config as Record<string, unknown>) ?? {},
  }
}

export default function ListenersPage() {
  const { user } = useAuth()
  const [listeners, setListeners] = useState<Listener[]>([])
  const [loading, setLoading] = useState(true)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [runs, setRuns] = useState<ListenerRun[]>([])
  const [agents, setAgents] = useState<NamedRow[]>([])
  const [tools, setTools] = useState<NamedRow[]>([])
  const [collections, setCollections] = useState<NamedRow[]>([])
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    const { data } = await supabase.from('event_listeners').select('*').order('created_at', { ascending: false })
    setListeners(data ?? [])
    setLoading(false)
  }, [])

  useEffect(() => {
    load()
    supabase.from('agents').select('id, name').eq('is_active', true).order('name').then(({ data }) => setAgents((data as NamedRow[]) ?? []))
    supabase.from('tools').select('id, name').eq('is_active', true).order('name').then(({ data }) => setTools((data as NamedRow[]) ?? []))
    supabase.from('collections').select('id, name').order('name').then(({ data }) => setCollections((data as NamedRow[]) ?? []))
  }, [load])

  const loadRuns = useCallback(async (id: string) => {
    const { data } = await supabase
      .from('event_listener_runs')
      .select('*')
      .eq('listener_id', id)
      .order('created_at', { ascending: false })
      .limit(20)
    setRuns(data ?? [])
  }, [])

  const select = (l: Listener) => {
    setDraft(toDraft(l))
    loadRuns(l.id)
  }

  const startNew = () => {
    setDraft(emptyDraft())
    setRuns([])
  }

  const patch = (p: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...p } : d))
  const patchMatch = (p: Partial<Draft['match']>) =>
    setDraft((d) => (d ? { ...d, match: { ...d.match, ...p } } : d))
  const patchConfig = (p: Record<string, unknown>) =>
    setDraft((d) => (d ? { ...d, action_config: { ...d.action_config, ...p } } : d))

  const save = async () => {
    if (!draft || !user) return
    if (!draft.name.trim()) return
    setSaving(true)
    // Drop empty match keys so filters are truly optional.
    const match: Record<string, string> = {}
    for (const [k, v] of Object.entries(draft.match)) if (v) match[k] = v as string
    const row = {
      name: draft.name.trim(),
      event_type: draft.event_type.trim(),
      is_active: draft.is_active,
      visibility: draft.visibility,
      match: match as Json,
      action_type: draft.action_type,
      action_config: draft.action_config as Json,
    }
    if (draft.id) {
      await supabase.from('event_listeners').update(row).eq('id', draft.id)
    } else {
      const { data } = await supabase
        .from('event_listeners')
        .insert({ ...row, owner_id: user.id })
        .select('*')
        .single()
      if (data) setDraft(toDraft(data as Listener))
    }
    setSaving(false)
    load()
  }

  const remove = async (id: string) => {
    await supabase.from('event_listeners').delete().eq('id', id)
    if (draft?.id === id) setDraft(null)
    load()
  }

  return (
    <div className="flex h-full overflow-hidden">
      {/* List */}
      <div className="flex w-full max-w-xs shrink-0 flex-col border-r border-border bg-surface">
        <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
          <h1 className="flex items-center gap-2 text-lg font-semibold text-text">
            <BoltIcon className="h-5 w-5 text-primary" /> Listeners
          </h1>
          <button
            onClick={startNew}
            className="flex items-center gap-1 rounded-lg bg-primary px-2 py-1.5 text-xs font-semibold text-white hover:bg-primary-strong"
          >
            <PlusIcon className="h-3.5 w-3.5" /> New
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {loading ? (
            <p className="p-4 text-sm text-faint">Loading…</p>
          ) : listeners.length === 0 ? (
            <p className="p-4 text-sm text-muted">No listeners yet. Create one to automate on events.</p>
          ) : (
            <ul>
              {listeners.map((l) => (
                <li key={l.id}>
                  <button
                    onClick={() => select(l)}
                    className={`flex w-full items-center gap-2 border-b border-border px-4 py-3 text-left transition hover:bg-surface-hover ${
                      draft?.id === l.id ? 'bg-primary-soft' : ''
                    }`}
                  >
                    <span className={`h-2 w-2 shrink-0 rounded-full ${l.is_active ? 'bg-emerald-500' : 'bg-slate-300'}`} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold text-text">{l.name}</span>
                      <span className="block truncate font-mono text-[11px] text-faint">
                        {l.event_type} → {l.action_type}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* Editor */}
      <div className="min-w-0 flex-1 overflow-y-auto">
        {!draft ? (
          <div className="flex h-full flex-col items-center justify-center text-center">
            <BoltIcon className="mb-3 h-10 w-10 text-faint" />
            <p className="max-w-sm text-sm text-muted">
              Event listeners run an action whenever a matching event happens — “when a file is added to the
              <span className="font-medium text-text"> Fubar</span> collection, run this agent”. Pick one or create a new one.
            </p>
          </div>
        ) : (
          <div className="mx-auto max-w-2xl px-6 py-6">
            <div className="flex items-center justify-between gap-3">
              <input
                value={draft.name}
                onChange={(e) => patch({ name: e.target.value })}
                placeholder="Listener name"
                className="min-w-0 flex-1 rounded-lg border border-border bg-surface px-3 py-2 text-base font-semibold text-text"
              />
              {draft.id && (
                <button
                  onClick={() => remove(draft.id!)}
                  className="rounded-lg border border-border p-2 text-faint hover:bg-red-50 hover:text-red-600"
                  title="Delete"
                >
                  <TrashIcon className="h-4 w-4" />
                </button>
              )}
            </div>

            {/* WHEN */}
            <section className="mt-6">
              <h3 className="text-xs font-bold uppercase tracking-wider text-faint">When this happens</h3>
              <div className="mt-2 space-y-3 rounded-xl border border-border bg-surface p-4">
                <label className="block">
                  <span className="text-sm font-medium text-text">Event</span>
                  <select
                    value={EVENT_TYPES.some((t) => t.value === draft.event_type) ? draft.event_type : '__custom'}
                    onChange={(e) => e.target.value !== '__custom' && patch({ event_type: e.target.value })}
                    className="mt-1 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text"
                  >
                    {EVENT_TYPES.map((t) => (
                      <option key={t.value} value={t.value}>
                        {t.label} ({t.value})
                      </option>
                    ))}
                    <option value="__custom">Custom…</option>
                  </select>
                  {!EVENT_TYPES.some((t) => t.value === draft.event_type) && (
                    <input
                      value={draft.event_type}
                      onChange={(e) => patch({ event_type: e.target.value })}
                      placeholder="e.g. artifact.updated or file.*"
                      className="mt-2 w-full rounded-lg border border-border bg-surface px-3 py-2 font-mono text-sm text-text"
                    />
                  )}
                </label>

                {/* Optional filters */}
                <div className="grid gap-3 sm:grid-cols-3">
                  {draft.event_type.startsWith('collection') && (
                    <label className="block">
                      <span className="text-xs font-medium text-muted">In collection</span>
                      <select
                        value={draft.match.collection_id ?? ''}
                        onChange={(e) => patchMatch({ collection_id: e.target.value || undefined })}
                        className="mt-1 w-full rounded-lg border border-border bg-surface px-2 py-1.5 text-sm text-text"
                      >
                        <option value="">Any</option>
                        {collections.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  {(draft.event_type.startsWith('collection') || draft.event_type === '*') && (
                    <label className="block">
                      <span className="text-xs font-medium text-muted">Item type</span>
                      <select
                        value={draft.match.entity_type ?? ''}
                        onChange={(e) => patchMatch({ entity_type: e.target.value || undefined })}
                        className="mt-1 w-full rounded-lg border border-border bg-surface px-2 py-1.5 text-sm text-text"
                      >
                        <option value="">Any</option>
                        {ENTITY_TYPES.map((t) => (
                          <option key={t} value={t}>
                            {t}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  {draft.event_type.startsWith('message') && (
                    <label className="block">
                      <span className="text-xs font-medium text-muted">From source</span>
                      <select
                        value={draft.match.source ?? ''}
                        onChange={(e) => patchMatch({ source: e.target.value || undefined })}
                        className="mt-1 w-full rounded-lg border border-border bg-surface px-2 py-1.5 text-sm text-text"
                      >
                        <option value="">Any</option>
                        {SOURCES.map((s) => (
                          <option key={s} value={s}>
                            {s}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                </div>
              </div>
            </section>

            {/* DO */}
            <section className="mt-5">
              <h3 className="text-xs font-bold uppercase tracking-wider text-faint">Do this</h3>
              <div className="mt-2 space-y-3 rounded-xl border border-border bg-surface p-4">
                <div className="grid gap-2 sm:grid-cols-2">
                  {ACTIONS.map((a) => (
                    <button
                      key={a.value}
                      onClick={() => patch({ action_type: a.value, action_config: {} })}
                      className={`rounded-lg border p-3 text-left transition ${
                        draft.action_type === a.value
                          ? 'border-primary bg-primary-soft'
                          : 'border-border hover:bg-surface-hover'
                      }`}
                    >
                      <span className="block text-sm font-semibold text-text">{a.label}</span>
                      <span className="block text-xs text-muted">{a.hint}</span>
                    </button>
                  ))}
                </div>

                {draft.action_type === 'run_agent' && (
                  <div className="space-y-2">
                    <label className="block">
                      <span className="text-sm font-medium text-text">Agent</span>
                      <select
                        value={String(draft.action_config.agent_id ?? '')}
                        onChange={(e) => patchConfig({ agent_id: e.target.value })}
                        className="mt-1 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text"
                      >
                        <option value="">Choose an agent…</option>
                        {agents.map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="block">
                      <span className="text-sm font-medium text-text">Extra instructions (optional)</span>
                      <textarea
                        value={String(draft.action_config.instructions ?? '')}
                        onChange={(e) => patchConfig({ instructions: e.target.value })}
                        rows={2}
                        placeholder="Added to the agent's task for this event."
                        className="mt-1 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text"
                      />
                    </label>
                  </div>
                )}

                {draft.action_type === 'run_tool' && (
                  <div className="space-y-2">
                    <label className="block">
                      <span className="text-sm font-medium text-text">Tool</span>
                      <select
                        value={String(draft.action_config.tool ?? '')}
                        onChange={(e) => patchConfig({ tool: e.target.value })}
                        className="mt-1 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text"
                      >
                        <option value="">Choose a tool…</option>
                        {tools.map((t) => (
                          <option key={t.id} value={t.name}>
                            {t.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="block">
                      <span className="text-sm font-medium text-text">Input (JSON)</span>
                      <textarea
                        value={
                          typeof draft.action_config.input === 'string'
                            ? (draft.action_config.input as string)
                            : JSON.stringify(draft.action_config.input ?? {}, null, 2)
                        }
                        onChange={(e) => {
                          try {
                            patchConfig({ input: JSON.parse(e.target.value) })
                          } catch {
                            patchConfig({ input: e.target.value })
                          }
                        }}
                        rows={4}
                        placeholder={'{ "note": "Saw {{event}}" }'}
                        className="mt-1 w-full rounded-lg border border-border bg-surface px-3 py-2 font-mono text-xs text-text"
                      />
                      <span className="mt-1 block text-xs text-faint">
                        <code>{'{{event}}'}</code> is replaced with the event JSON.
                      </span>
                    </label>
                  </div>
                )}

                {draft.action_type === 'add_to_collection' && (
                  <label className="block">
                    <span className="text-sm font-medium text-text">Collection</span>
                    <select
                      value={String(draft.action_config.collection_id ?? '')}
                      onChange={(e) => patchConfig({ collection_id: e.target.value })}
                      className="mt-1 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text"
                    >
                      <option value="">Choose a collection…</option>
                      {collections.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
              </div>
            </section>

            {/* Options + save */}
            <div className="mt-5 flex flex-wrap items-center gap-4">
              <label className="flex cursor-pointer items-center gap-2 text-sm text-text">
                <input type="checkbox" checked={draft.is_active} onChange={(e) => patch({ is_active: e.target.checked })} />
                Active
              </label>
              <label className="flex cursor-pointer items-center gap-2 text-sm text-text">
                <input
                  type="checkbox"
                  checked={draft.visibility === 'workspace'}
                  onChange={(e) => patch({ visibility: e.target.checked ? 'workspace' : 'private' })}
                />
                Shared with the workspace
              </label>
              <button
                onClick={save}
                disabled={saving || !draft.name.trim()}
                className="ml-auto rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white transition hover:bg-primary-strong disabled:opacity-50"
              >
                {saving ? 'Saving…' : draft.id ? 'Save changes' : 'Create listener'}
              </button>
            </div>

            {/* Recent runs */}
            {draft.id && (
              <section className="mt-8">
                <h3 className="text-xs font-bold uppercase tracking-wider text-faint">Recent runs</h3>
                {runs.length === 0 ? (
                  <p className="mt-2 text-sm text-muted">No runs yet. When a matching event fires, it shows here.</p>
                ) : (
                  <ol className="mt-2 space-y-2">
                    {runs.map((r) => (
                      <li key={r.id} className="rounded-lg border border-border bg-surface p-3">
                        <div className="flex items-center gap-2">
                          <span
                            className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                              r.status === 'error'
                                ? 'bg-red-100 text-red-700'
                                : r.status === 'skipped'
                                  ? 'bg-surface-2 text-muted'
                                  : 'bg-emerald-100 text-emerald-700'
                            }`}
                          >
                            {r.status}
                          </span>
                          <span className="ml-auto text-xs text-faint">{formatDate(r.created_at)}</span>
                        </div>
                        {(r.result || r.error) && (
                          <pre className="mt-1.5 max-h-32 overflow-auto whitespace-pre-wrap rounded bg-surface-2 p-2 text-[11px] text-muted">
                            {r.error || r.result}
                          </pre>
                        )}
                      </li>
                    ))}
                  </ol>
                )}
              </section>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
