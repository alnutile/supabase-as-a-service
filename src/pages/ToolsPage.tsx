import { useCallback, useEffect, useState } from 'react'
import type { Database } from '../lib/database.types'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import { GlobeIcon, PlusIcon, ToolIcon, TrashIcon } from '../components/icons'

type Tool = Database['public']['Tables']['tools']['Row']

const SCHEMA_TEMPLATE = `{
  "type": "object",
  "properties": {
    "query": { "type": "string", "description": "What to look up" }
  },
  "required": ["query"]
}`

export default function ToolsPage() {
  const { user } = useAuth()
  const [tools, setTools] = useState<Tool[]>([])
  const [forgedIds, setForgedIds] = useState<Set<string>>(new Set())
  const [isAdmin, setIsAdmin] = useState(false)
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<Tool | null>(null)

  const load = useCallback(async () => {
    const [{ data }, { data: forged }] = await Promise.all([
      supabase
        .from('tools')
        .select('*')
        .order('is_builtin', { ascending: false })
        .order('updated_at', { ascending: false }),
      supabase.from('forged_functions').select('tool_id'),
    ])
    setTools(data ?? [])
    setForgedIds(new Set((forged ?? []).map((f) => f.tool_id).filter((id): id is string => Boolean(id))))
    setLoading(false)
  }, [])

  useEffect(() => {
    load()
  }, [load])

  useEffect(() => {
    if (!user) return
    supabase
      .from('profiles')
      .select('is_admin')
      .eq('id', user.id)
      .maybeSingle()
      .then(({ data }) => setIsAdmin(Boolean(data?.is_admin)))
  }, [user])

  async function create() {
    const { data } = await supabase
      .from('tools')
      .insert({
        name: 'new_tool',
        description: '',
        kind: 'http',
        input_schema: JSON.parse(SCHEMA_TEMPLATE),
        config: { url: '', method: 'POST' },
        is_active: false,
        created_by: user!.id,
      })
      .select()
      .single()
    if (data) {
      await load()
      setEditing(data)
    }
  }

  async function toggleActive(tool: Tool) {
    if (!isAdmin) return
    await supabase
      .from('tools')
      .update({ is_active: !tool.is_active, updated_at: new Date().toISOString() })
      .eq('id', tool.id)
    load()
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl px-6 py-8">
        <div className="mb-1 flex items-center justify-between">
          <h1 className="text-2xl font-semibold tracking-tight text-text">Tools</h1>
          {isAdmin && (
            <button
              onClick={create}
              className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white hover:bg-primary-strong"
            >
              <PlusIcon className="h-4 w-4" /> New tool
            </button>
          )}
        </div>
        <p className="mb-6 text-sm text-muted">
          Capabilities the assistant can call during chat. Each tool becomes a real function the
          AI can use. Custom tools POST the AI’s inputs to a URL you choose.
        </p>

        {loading ? (
          <p className="text-sm text-faint">Loading…</p>
        ) : (
          <div className="space-y-3">
            {tools.map((t) => (
              <div
                key={t.id}
                className="flex items-center gap-3 rounded-xl border border-border bg-surface p-4"
              >
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-muted">
                  {t.kind === 'web' ? (
                    <GlobeIcon className="h-5 w-5" />
                  ) : (
                    <ToolIcon className="h-5 w-5" />
                  )}
                </div>
                <button
                  onClick={() => t.kind === 'http' && isAdmin && setEditing(t)}
                  className="min-w-0 flex-1 text-left"
                  disabled={t.kind !== 'http' || !isAdmin}
                >
                  <div className="flex items-center gap-2">
                    <span className="truncate font-mono text-sm font-medium text-text">
                      {t.kind === 'web' ? 'Web browsing' : t.name}
                    </span>
                    {t.is_builtin && (
                      <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted">
                        Built-in
                      </span>
                    )}
                    {forgedIds.has(t.id) && (
                      <span className="rounded-full bg-primary-soft px-2 py-0.5 text-[10px] uppercase tracking-wide text-primary">
                        Forged
                      </span>
                    )}
                    {t.kind === 'mcp' && (
                      <span className="rounded-full bg-primary-soft px-2 py-0.5 text-[10px] uppercase tracking-wide text-primary">
                        MCP
                      </span>
                    )}
                  </div>
                  <p className="mt-0.5 line-clamp-1 text-xs text-muted">
                    {t.kind === 'mcp'
                      ? `External MCP server · ${(t.config as { url?: string })?.url ?? 'no endpoint'} — manage in Settings`
                      : t.description || (t.kind === 'http' ? (t.config as { url?: string })?.url || 'No endpoint set' : '')}
                  </p>
                </button>

                {/* Active toggle */}
                <button
                  onClick={() => toggleActive(t)}
                  disabled={!isAdmin}
                  title={t.is_active ? 'Enabled' : 'Disabled'}
                  className={`relative h-6 w-11 shrink-0 rounded-full transition ${
                    t.is_active ? 'bg-primary' : 'bg-border-strong'
                  } ${isAdmin ? '' : 'opacity-60'}`}
                >
                  <span
                    className={`absolute top-0.5 h-5 w-5 rounded-full bg-surface transition ${
                      t.is_active ? 'left-[22px]' : 'left-0.5'
                    }`}
                  />
                </button>
              </div>
            ))}
            {!isAdmin && (
              <p className="text-xs text-faint">Only an admin can add or change tools.</p>
            )}
          </div>
        )}
      </div>

      {editing && (
        <ToolEditor
          tool={editing}
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

function ToolEditor({
  tool,
  onClose,
  onSaved,
}: {
  tool: Tool
  onClose: () => void
  onSaved: () => void
}) {
  const cfg = (tool.config as { url?: string; method?: string; headers?: Record<string, string> }) ?? {}
  const [name, setName] = useState(tool.name)
  const [description, setDescription] = useState(tool.description)
  const [url, setUrl] = useState(cfg.url ?? '')
  const [method, setMethod] = useState(cfg.method ?? 'POST')
  const [headers, setHeaders] = useState(
    cfg.headers && Object.keys(cfg.headers).length ? JSON.stringify(cfg.headers, null, 2) : ''
  )
  const [schema, setSchema] = useState(JSON.stringify(tool.input_schema, null, 2))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function save() {
    let parsedSchema: unknown
    try {
      parsedSchema = JSON.parse(schema)
    } catch {
      setError('Input schema is not valid JSON.')
      return
    }
    let parsedHeaders: Record<string, string> | undefined
    if (headers.trim()) {
      try {
        const h = JSON.parse(headers)
        if (typeof h !== 'object' || h === null || Array.isArray(h)) throw new Error()
        parsedHeaders = Object.fromEntries(Object.entries(h).map(([k, v]) => [k, String(v)]))
      } catch {
        setError('Headers must be a JSON object of header name → value.')
        return
      }
    }
    if (!/^[a-z][a-z0-9_]*$/.test(name)) {
      setError('Name must be snake_case (lowercase letters, numbers, underscores).')
      return
    }
    setSaving(true)
    setError(null)
    const { error: upErr } = await supabase
      .from('tools')
      .update({
        name,
        description,
        input_schema: parsedSchema as never,
        config: { url, method, ...(parsedHeaders ? { headers: parsedHeaders } : {}) },
        updated_at: new Date().toISOString(),
      })
      .eq('id', tool.id)
    setSaving(false)
    if (upErr) {
      setError(upErr.message)
      return
    }
    onSaved()
  }

  async function remove() {
    if (!confirm(`Delete tool “${tool.name}”?`)) return
    await supabase.from('tools').delete().eq('id', tool.id)
    onSaved()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/40 sm:items-center sm:p-4">
      <div className="flex max-h-[92vh] w-full max-w-lg flex-col overflow-hidden rounded-t-2xl bg-surface shadow-xl sm:rounded-2xl">
        <div className="flex items-center justify-between border-b border-border px-5 py-3">
          <h2 className="text-sm font-semibold text-text">Custom tool</h2>
          <button
            onClick={remove}
            className="rounded-md p-1.5 text-faint hover:bg-red-50 hover:text-red-600"
            title="Delete"
          >
            <TrashIcon className="h-[18px] w-[18px]" />
          </button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto p-5">
          <Field label="Name (snake_case — the function name the AI calls)">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full rounded-lg border border-border-strong px-3 py-2 font-mono text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary-soft"
            />
          </Field>
          <Field label="Description — tell the AI when to use it">
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              placeholder="e.g. Look up an order by id in our fulfillment system."
              className="w-full resize-y rounded-lg border border-border-strong px-3 py-2 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary-soft"
            />
          </Field>
          <div className="flex gap-3">
            <Field label="Endpoint URL (receives the inputs)">
              <input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://api.example.com/lookup"
                className="w-full rounded-lg border border-border-strong px-3 py-2 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary-soft"
              />
            </Field>
            <label className="block w-24 shrink-0">
              <span className="mb-1 block text-xs font-medium text-muted">Method</span>
              <select
                value={method}
                onChange={(e) => setMethod(e.target.value)}
                className="w-full rounded-lg border border-border-strong px-2 py-2 text-sm"
              >
                <option>POST</option>
                <option>GET</option>
              </select>
            </label>
          </div>
          <Field label="Headers (JSON object, optional — sent with every call)">
            <textarea
              value={headers}
              onChange={(e) => setHeaders(e.target.value)}
              rows={3}
              spellCheck={false}
              placeholder={'{\n  "Authorization": "Bearer {{vault:my_api_key}}"\n}'}
              className="w-full resize-y rounded-lg border border-border-strong px-3 py-2 font-mono text-[12px] leading-relaxed outline-none focus:border-primary focus:ring-2 focus:ring-primary-soft"
            />
            <p className="mt-1 text-xs text-faint">
              Use <code className="font-mono">{'{{vault:secret_name}}'}</code> to insert a secret
              from the Vault at call time — the value never leaves the server and the AI never
              sees it. Workspace-shared secrets only.
            </p>
          </Field>
          <Field label="Input schema (JSON Schema for the arguments)">
            <textarea
              value={schema}
              onChange={(e) => setSchema(e.target.value)}
              rows={10}
              spellCheck={false}
              className="w-full resize-y rounded-lg border border-border-strong px-3 py-2 font-mono text-[12px] leading-relaxed outline-none focus:border-primary focus:ring-2 focus:ring-primary-soft"
            />
          </Field>
          <p className="text-xs text-faint">
            When the AI calls this tool, the app POSTs the arguments as JSON to your endpoint and
            feeds the response back to the AI. Enable it with the toggle once saved.
          </p>
          {error && <p className="text-sm text-red-600">{error}</p>}
        </div>

        <div className="flex justify-end gap-2 border-t border-border px-5 py-3">
          <button
            onClick={onClose}
            className="rounded-lg px-3 py-2 text-sm font-medium text-muted hover:bg-surface-hover"
          >
            Cancel
          </button>
          <button
            onClick={save}
            disabled={saving || !name.trim()}
            className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white hover:bg-primary-strong disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block flex-1">
      <span className="mb-1 block text-xs font-medium text-muted">{label}</span>
      {children}
    </label>
  )
}
