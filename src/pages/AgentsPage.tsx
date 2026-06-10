import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { Database } from '../lib/database.types'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import { formatDate } from '../lib/util'
import { AgentIcon, ChatIcon, PlusIcon, TrashIcon } from '../components/icons'

type Agent = Database['public']['Tables']['agents']['Row']
type Tool = Database['public']['Tables']['tools']['Row']

export default function AgentsPage() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const [agents, setAgents] = useState<Agent[]>([])
  const [tools, setTools] = useState<Tool[]>([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<Agent | null>(null)

  const load = useCallback(async () => {
    const [{ data: a }, { data: t }] = await Promise.all([
      supabase.from('agents').select('*').order('updated_at', { ascending: false }),
      supabase.from('tools').select('*').eq('is_active', true),
    ])
    setAgents(a ?? [])
    setTools(t ?? [])
    setLoading(false)
  }, [])

  useEffect(() => {
    load()
  }, [load])

  async function create() {
    const { data } = await supabase
      .from('agents')
      .insert({ owner_id: user!.id, name: 'New agent', instructions: '' })
      .select()
      .single()
    if (data) {
      await load()
      setEditing(data)
    }
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl px-6 py-8">
        <div className="mb-1 flex items-center justify-between">
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900">Agents</h1>
          <button
            onClick={create}
            className="flex items-center gap-2 rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700"
          >
            <PlusIcon className="h-4 w-4" /> New agent
          </button>
        </div>
        <p className="mb-6 text-sm text-slate-500">
          An agent bundles a system prompt with the tools it may use. Build them here, or have an
          external Claude build them over MCP (Settings → Connect Claude).
        </p>

        {loading ? (
          <p className="text-sm text-slate-400">Loading…</p>
        ) : agents.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-slate-300 py-16 text-center">
            <AgentIcon className="mx-auto mb-3 h-8 w-8 text-slate-300" />
            <p className="text-sm text-slate-500">No agents yet. Create one, or build one from Claude over MCP.</p>
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {agents.map((a) => (
              <div key={a.id} className="flex flex-col rounded-xl border border-slate-200 bg-white p-4">
                <div className="flex items-center gap-2">
                  <AgentIcon className="h-5 w-5 shrink-0 text-brand-500" />
                  <span className="min-w-0 flex-1 truncate font-medium text-slate-800">{a.name}</span>
                  {!a.is_active && <span className="text-[10px] uppercase text-slate-400">off</span>}
                </div>
                <p className="mt-1 line-clamp-2 text-xs text-slate-500">
                  {a.description || a.instructions.slice(0, 100) || 'No description'}
                </p>
                <p className="mt-2 text-[11px] text-slate-400">
                  {a.tool_ids.length} tool{a.tool_ids.length === 1 ? '' : 's'} · {formatDate(a.updated_at)}
                </p>
                <div className="mt-3 flex gap-2">
                  <button
                    onClick={() => navigate(`/chat?agent=${a.id}`)}
                    className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand-700"
                  >
                    <ChatIcon className="h-3.5 w-3.5" /> Chat
                  </button>
                  <button
                    onClick={() => setEditing(a)}
                    className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50"
                  >
                    Edit
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {editing && (
        <AgentEditor
          agent={editing}
          tools={tools}
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

function AgentEditor({
  agent,
  tools,
  onClose,
  onSaved,
}: {
  agent: Agent
  tools: Tool[]
  onClose: () => void
  onSaved: () => void
}) {
  const [name, setName] = useState(agent.name)
  const [description, setDescription] = useState(agent.description)
  const [instructions, setInstructions] = useState(agent.instructions)
  const [toolIds, setToolIds] = useState<string[]>(agent.tool_ids)
  const [isActive, setIsActive] = useState(agent.is_active)
  const [saving, setSaving] = useState(false)

  function toggleTool(id: string) {
    setToolIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
  }

  async function save() {
    setSaving(true)
    await supabase
      .from('agents')
      .update({
        name,
        description,
        instructions,
        tool_ids: toolIds,
        is_active: isActive,
        updated_at: new Date().toISOString(),
      })
      .eq('id', agent.id)
    setSaving(false)
    onSaved()
  }

  async function remove() {
    if (!confirm(`Delete agent “${agent.name}”?`)) return
    await supabase.from('agents').delete().eq('id', agent.id)
    onSaved()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/40 sm:items-center sm:p-4">
      <div className="flex max-h-[92vh] w-full max-w-lg flex-col overflow-hidden rounded-t-2xl bg-white shadow-xl sm:rounded-2xl">
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3">
          <h2 className="text-sm font-semibold text-slate-700">Agent</h2>
          <button
            onClick={remove}
            className="rounded-md p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600"
            title="Delete"
          >
            <TrashIcon className="h-[18px] w-[18px]" />
          </button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto p-5">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-600">Name</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-600">Description (optional)</span>
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-600">
              Instructions (the agent’s system prompt)
            </span>
            <textarea
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              rows={8}
              placeholder="You are a support triage agent. For each message, classify urgency and draft a reply…"
              className="w-full resize-y rounded-lg border border-slate-300 px-3 py-2 font-mono text-[13px] leading-relaxed outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
            />
          </label>
          <div>
            <span className="mb-1 block text-xs font-medium text-slate-600">Tools it may use</span>
            {tools.length === 0 ? (
              <p className="text-xs text-slate-400">No active tools. Add some on the Tools page.</p>
            ) : (
              <div className="space-y-1">
                {tools.map((t) => (
                  <label key={t.id} className="flex items-center gap-2 text-sm text-slate-700">
                    <input
                      type="checkbox"
                      checked={toolIds.includes(t.id)}
                      onChange={() => toggleTool(t.id)}
                      className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
                    />
                    <span className="font-mono text-xs">{t.kind === 'web' ? 'web_browsing' : t.name}</span>
                  </label>
                ))}
              </div>
            )}
          </div>
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={isActive}
              onChange={(e) => setIsActive(e.target.checked)}
              className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
            />
            Active
          </label>
        </div>

        <div className="flex justify-end gap-2 border-t border-slate-200 px-5 py-3">
          <button
            onClick={onClose}
            className="rounded-lg px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100"
          >
            Cancel
          </button>
          <button
            onClick={save}
            disabled={saving || !name.trim()}
            className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}
