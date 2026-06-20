import { useCallback, useEffect, useState } from 'react'
import type { Database, WebhookEventStatus } from '../lib/database.types'
import { supabase, webhookUrl } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import { formatDate } from '../lib/util'
import { CopyIcon, PlusIcon, TrashIcon, WebhookIcon } from '../components/icons'

type Webhook = Database['public']['Tables']['webhooks']['Row']
type WebhookEvent = Database['public']['Tables']['webhook_events']['Row']
type Agent = Database['public']['Tables']['agents']['Row']
type Tool = Database['public']['Tables']['tools']['Row']

export default function WebhooksPage() {
  const { user } = useAuth()
  const [webhooks, setWebhooks] = useState<Webhook[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const loadWebhooks = useCallback(async () => {
    const { data } = await supabase.from('webhooks').select('*').order('updated_at', { ascending: false })
    setWebhooks(data ?? [])
    setLoading(false)
    setSelectedId((cur) => cur ?? data?.[0]?.id ?? null)
  }, [])

  useEffect(() => {
    loadWebhooks()
  }, [loadWebhooks])

  async function create() {
    const { data } = await supabase
      .from('webhooks')
      .insert({ owner_id: user!.id, name: 'New webhook', prompt: '' })
      .select()
      .single()
    if (data) {
      setWebhooks((w) => [data, ...w])
      setSelectedId(data.id)
    }
  }

  const selected = webhooks.find((w) => w.id === selectedId) ?? null

  return (
    <div className="flex h-full flex-col md:flex-row">
      {/* List */}
      <div className="flex max-h-56 shrink-0 flex-col border-b border-slate-200 bg-white md:max-h-none md:w-72 md:border-b-0 md:border-r">
        <div className="flex items-center justify-between px-4 py-3">
          <h1 className="text-sm font-semibold text-slate-700">Webhooks</h1>
          <button
            onClick={create}
            className="flex items-center gap-1 rounded-lg bg-brand-600 px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-brand-700"
          >
            <PlusIcon className="h-3.5 w-3.5" /> New
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-2 pb-2">
          {loading ? (
            <p className="px-2 py-3 text-sm text-slate-400">Loading…</p>
          ) : webhooks.length === 0 ? (
            <p className="px-2 py-3 text-sm text-slate-400">No webhooks yet.</p>
          ) : (
            webhooks.map((w) => (
              <button
                key={w.id}
                onClick={() => setSelectedId(w.id)}
                className={`mb-1 flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition ${
                  w.id === selectedId ? 'bg-brand-50 text-brand-700' : 'text-slate-600 hover:bg-slate-100'
                }`}
              >
                <WebhookIcon className="h-4 w-4 shrink-0" />
                <span className="min-w-0 flex-1 truncate font-medium">{w.name}</span>
                {!w.is_active && <span className="text-[10px] uppercase text-slate-400">off</span>}
              </button>
            ))
          )}
        </div>
      </div>

      {/* Detail */}
      <div className="min-w-0 flex-1 overflow-y-auto">
        {selected ? (
          <WebhookDetail
            key={selected.id}
            webhook={selected}
            onChange={(w) => setWebhooks((list) => list.map((x) => (x.id === w.id ? w : x)))}
            onDelete={(id) => {
              setWebhooks((list) => list.filter((x) => x.id !== id))
              setSelectedId(null)
            }}
          />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-slate-400">
            <WebhookIcon className="h-10 w-10" />
            <p className="max-w-sm text-sm">
              Create a webhook to get a URL. Point any external system at it, attach a prompt, and
              every inbound payload is processed by the assistant.
            </p>
          </div>
        )}
      </div>
    </div>
  )
}

function WebhookDetail({
  webhook,
  onChange,
  onDelete,
}: {
  webhook: Webhook
  onChange: (w: Webhook) => void
  onDelete: (id: string) => void
}) {
  const [name, setName] = useState(webhook.name)
  const [prompt, setPrompt] = useState(webhook.prompt)
  const [isActive, setIsActive] = useState(webhook.is_active)
  const [agentId, setAgentId] = useState(webhook.agent_id ?? '')
  const [toolId, setToolId] = useState(webhook.tool_id ?? '')
  const [secret, setSecret] = useState(webhook.secret ?? '')
  const [allowTools, setAllowTools] = useState(webhook.allow_tools)
  const [agents, setAgents] = useState<Agent[]>([])
  const [tools, setTools] = useState<Tool[]>([])
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [copied, setCopied] = useState(false)
  const [events, setEvents] = useState<WebhookEvent[]>([])

  useEffect(() => {
    supabase
      .from('agents')
      .select('*')
      .eq('is_active', true)
      .order('name')
      .then(({ data }) => setAgents(data ?? []))
    // Only http tools (forged functions + custom HTTP tools) can be called directly.
    supabase
      .from('tools')
      .select('*')
      .eq('is_active', true)
      .eq('kind', 'http')
      .order('name')
      .then(({ data }) => setTools(data ?? []))
  }, [])

  const selectedTool = tools.find((t) => t.id === toolId) ?? null
  const url = webhookUrl(webhook.token)
  const dirty =
    name !== webhook.name ||
    prompt !== webhook.prompt ||
    isActive !== webhook.is_active ||
    agentId !== (webhook.agent_id ?? '') ||
    toolId !== (webhook.tool_id ?? '') ||
    secret !== (webhook.secret ?? '') ||
    allowTools !== webhook.allow_tools

  const loadEvents = useCallback(async () => {
    const { data } = await supabase
      .from('webhook_events')
      .select('*')
      .eq('webhook_id', webhook.id)
      .order('created_at', { ascending: false })
      .limit(50)
    setEvents(data ?? [])
  }, [webhook.id])

  useEffect(() => {
    loadEvents()
    // Live-refresh as events arrive / complete.
    const channel = supabase
      .channel(`webhook_events:${webhook.id}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'webhook_events', filter: `webhook_id=eq.${webhook.id}` },
        () => loadEvents(),
      )
      .subscribe()
    return () => {
      supabase.removeChannel(channel)
    }
  }, [webhook.id, loadEvents])

  async function save() {
    setSaving(true)
    const { data } = await supabase
      .from('webhooks')
      .update({
        name,
        prompt,
        is_active: isActive,
        agent_id: agentId || null,
        tool_id: toolId || null,
        secret: secret.trim() || null,
        allow_tools: allowTools,
        updated_at: new Date().toISOString(),
      })
      .eq('id', webhook.id)
      .select()
      .single()
    setSaving(false)
    if (data) {
      onChange(data)
      setSaved(true)
      setTimeout(() => setSaved(false), 1500)
    }
  }

  async function copy() {
    await navigator.clipboard.writeText(url)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  async function remove() {
    if (!confirm(`Delete “${webhook.name}” and its event history?`)) return
    await supabase.from('webhooks').delete().eq('id', webhook.id)
    onDelete(webhook.id)
  }

  return (
    <div className="mx-auto max-w-2xl px-6 py-6">
      <div className="flex items-start justify-between gap-3">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="min-w-0 flex-1 rounded-lg border border-transparent px-2 py-1 text-xl font-semibold text-slate-900 outline-none hover:border-slate-200 focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
        />
        <button
          onClick={remove}
          title="Delete webhook"
          className="mt-1 rounded-md p-2 text-slate-400 hover:bg-red-50 hover:text-red-600"
        >
          <TrashIcon className="h-[18px] w-[18px]" />
        </button>
      </div>

      {/* Endpoint */}
      <div className="mt-4 rounded-xl border border-slate-200 bg-white p-4">
        <span className="text-xs font-medium text-slate-600">Endpoint URL — POST your data here</span>
        <div className="mt-2 flex items-center gap-2">
          <code className="min-w-0 flex-1 truncate rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-700">
            {url}
          </code>
          <button
            onClick={copy}
            className="flex shrink-0 items-center gap-1 rounded-lg border border-slate-300 px-2.5 py-2 text-xs font-medium text-slate-600 hover:bg-slate-50"
          >
            <CopyIcon className="h-3.5 w-3.5" /> {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
        <details className="mt-2">
          <summary className="cursor-pointer text-xs text-slate-400">Test with curl</summary>
          <pre className="mt-2 overflow-x-auto rounded-lg bg-slate-900 p-3 text-[11px] leading-relaxed text-slate-100">
{`curl -X POST ${url} \\
  -H 'Content-Type: application/json' \\${
  secret.trim() ? `\n  -H 'Authorization: Bearer ${secret.trim()}' \\` : ''
}
  -d '${selectedTool ? JSON.stringify(samplePayload(selectedTool.input_schema)) : '{"hello":"world"}'}'`}
          </pre>
        </details>
      </div>

      {/* Shared secret (optional auth) */}
      <div className="mt-4 rounded-xl border border-slate-200 bg-white p-4">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-slate-600">
            Require a secret (optional)
          </span>
          <div className="flex gap-2">
            <button
              onClick={() => setSecret(crypto.randomUUID().replace(/-/g, ''))}
              className="rounded-lg border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50"
            >
              Generate
            </button>
            {secret && (
              <button
                onClick={() => setSecret('')}
                className="rounded-lg border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50"
              >
                Clear
              </button>
            )}
          </div>
        </div>
        <input
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
          placeholder="Leave blank for none — anyone with the URL can call it"
          className="mt-2 w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-xs outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
        />
        <p className="mt-1.5 text-xs text-slate-500">
          When set, callers must send it as{' '}
          <code className="font-mono">Authorization: Bearer …</code> or{' '}
          <code className="font-mono">X-Webhook-Secret: …</code>. Requests without it get a 401.
        </p>
      </div>

      {/* Call a function directly (deterministic) */}
      <div className="mt-4">
        <label className="mb-1 block text-xs font-medium text-slate-600">
          Call a function directly (optional, deterministic)
        </label>
        <select
          value={toolId}
          onChange={(e) => setToolId(e.target.value)}
          className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
        >
          <option value="">No function — use the AI options below</option>
          {tools.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
        {selectedTool && (
          <div className="mt-2 rounded-lg border border-slate-200 bg-slate-50 p-3">
            <p className="text-xs text-emerald-700">
              Deterministic: each payload is validated against these fields and sent straight to{' '}
              <code className="font-mono">{selectedTool.name}</code> — no AI, no agent/prompt.
            </p>
            <SchemaFields schema={selectedTool.input_schema} />
            <details className="mt-2">
              <summary className="cursor-pointer text-xs text-slate-400">Sample payload</summary>
              <pre className="mt-1 overflow-x-auto rounded-lg bg-slate-900 p-2 text-[11px] leading-relaxed text-slate-100">
                {JSON.stringify(samplePayload(selectedTool.input_schema), null, 2)}
              </pre>
            </details>
          </div>
        )}
      </div>

      {/* Agent (optional) */}
      <div className={`mt-4 ${toolId ? 'pointer-events-none opacity-40' : ''}`}>
        <label className="mb-1 block text-xs font-medium text-slate-600">
          Run an agent (optional)
        </label>
        <select
          value={agentId}
          onChange={(e) => setAgentId(e.target.value)}
          className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
        >
          <option value="">No agent — use the prompt below</option>
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
        {agentId && (
          <>
            <p className="mt-1 text-xs text-amber-600">
              This webhook runs the agent on each payload. The prompt below is ignored.
            </p>
            <label className="mt-3 flex items-start gap-2 rounded-lg border border-slate-200 bg-slate-50 p-2.5 text-sm text-slate-700">
              <input
                type="checkbox"
                checked={allowTools}
                onChange={(e) => setAllowTools(e.target.checked)}
                className="mt-0.5 h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
              />
              <span>
                Allow agent tools
                <span className="mt-0.5 block text-xs font-normal text-slate-500">
                  Tools let the agent act on whatever this webhook receives. Leave off unless the
                  source is trusted — otherwise the agent runs read-only.
                </span>
              </span>
            </label>
          </>
        )}
      </div>

      {/* Prompt */}
      <div className={`mt-4 ${toolId ? 'pointer-events-none opacity-40' : ''}`}>
        <label className="mb-1 block text-xs font-medium text-slate-600">
          Prompt — what to do with each incoming payload
        </label>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={6}
          placeholder="e.g. You receive form submissions. Summarize each one in two sentences and flag anything urgent."
          className="w-full resize-y rounded-lg border border-slate-300 px-3 py-2 font-mono text-[13px] leading-relaxed outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
        />
      </div>

      <div className="mt-3 flex items-center justify-between">
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input
            type="checkbox"
            checked={isActive}
            onChange={(e) => setIsActive(e.target.checked)}
            className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
          />
          Active {isActive ? '' : '(paused — requests are rejected)'}
        </label>
        <button
          onClick={save}
          disabled={saving || !dirty || !name.trim()}
          className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50"
        >
          {saving ? 'Saving…' : saved ? 'Saved!' : 'Save'}
        </button>
      </div>

      {/* Events */}
      <h2 className="mt-8 text-xs font-semibold uppercase tracking-wide text-slate-500">
        Recent events
      </h2>
      <div className="mt-2 space-y-2 pb-8">
        {events.length === 0 ? (
          <p className="rounded-xl border border-dashed border-slate-300 py-8 text-center text-sm text-slate-400">
            No events yet. POST to the URL above to see them here live.
          </p>
        ) : (
          events.map((ev) => <EventRow key={ev.id} event={ev} />)
        )}
      </div>
    </div>
  )
}

const STATUS_STYLES: Record<WebhookEventStatus, string> = {
  received: 'bg-amber-100 text-amber-700',
  ok: 'bg-emerald-100 text-emerald-700',
  error: 'bg-red-100 text-red-700',
  blocked: 'bg-red-100 text-red-700',
}

type SchemaShape = {
  properties?: Record<string, { type?: string; description?: string }>
  required?: string[]
}

// Render the declared fields + types of a tool's input_schema.
function SchemaFields({ schema }: { schema: unknown }) {
  const s = (schema ?? {}) as SchemaShape
  const props = s.properties ?? {}
  const required = new Set(s.required ?? [])
  const entries = Object.entries(props)
  if (entries.length === 0) {
    return <p className="mt-2 text-xs text-slate-400">This function takes no defined fields.</p>
  }
  return (
    <ul className="mt-2 space-y-1">
      {entries.map(([key, spec]) => (
        <li key={key} className="flex items-baseline gap-2 text-xs">
          <code className="font-mono text-slate-700">{key}</code>
          <span className="text-slate-400">{spec?.type ?? 'any'}</span>
          {required.has(key) && <span className="text-[10px] uppercase text-amber-600">required</span>}
          {spec?.description && <span className="truncate text-slate-400">— {spec.description}</span>}
        </li>
      ))}
    </ul>
  )
}

// Build an example payload from an input_schema for the "Sample payload" preview.
function samplePayload(schema: unknown): Record<string, unknown> {
  const s = (schema ?? {}) as SchemaShape
  const out: Record<string, unknown> = {}
  for (const [key, spec] of Object.entries(s.properties ?? {})) {
    switch (spec?.type) {
      case 'number':
      case 'integer':
        out[key] = 0
        break
      case 'boolean':
        out[key] = false
        break
      case 'array':
        out[key] = []
        break
      case 'object':
        out[key] = {}
        break
      default:
        out[key] = 'example'
    }
  }
  return out
}

function EventRow({ event }: { event: WebhookEvent }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3">
      <div className="flex items-center gap-2">
        <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium uppercase ${STATUS_STYLES[event.status]}`}>
          {event.status}
        </span>
        <span className="text-xs text-slate-400">{formatDate(event.created_at)}</span>
      </div>
      {event.result && (
        <p className="mt-2 whitespace-pre-wrap text-sm text-slate-700">{event.result}</p>
      )}
      {event.error && <p className="mt-2 text-sm text-red-600">{event.error}</p>}
      {event.payload != null && (
        <details className="mt-2">
          <summary className="cursor-pointer text-xs text-slate-400">Payload</summary>
          <pre className="mt-1 max-h-48 overflow-auto rounded-lg bg-slate-50 p-2 text-[11px] text-slate-600">
            {JSON.stringify(event.payload, null, 2)}
          </pre>
        </details>
      )}
    </div>
  )
}
