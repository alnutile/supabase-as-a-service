import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { Database } from '../lib/database.types'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import { formatDate } from '../lib/util'
import { CRON_EXAMPLES, describeCron, isValidCron, localTimezone, nextCronRuns } from '../lib/cron'
import { allToolsSelected as allSelected, toggleAllTools } from '../lib/agentTools'
import { AddToCollectionBar } from '../components/AddToCollectionBar'
import { CollectionPicker } from '../components/CollectionPicker'
import { ActivityIcon, AgentIcon, ChatIcon, CheckIcon, CloseIcon, PlayIcon, PlusIcon, SearchIcon, SkillIcon, TrashIcon } from '../components/icons'

// Stable identity for "nothing picked" — the picker memoizes on `selected`.
const EMPTY_SELECTION: Set<string> = new Set()

type Agent = Database['public']['Tables']['agents']['Row']
type Tool = Database['public']['Tables']['tools']['Row']
type Schedule = Database['public']['Tables']['schedules']['Row']
type Skill = Database['public']['Tables']['skills']['Row']
type Collection = Database['public']['Tables']['collections']['Row']

const INTERVALS = [
  { label: 'Every 15 minutes', minutes: 15 },
  { label: 'Hourly', minutes: 60 },
  { label: 'Daily', minutes: 1440 },
  { label: 'Weekly', minutes: 10080 },
]
const intervalLabel = (m: number) => INTERVALS.find((i) => i.minutes === m)?.label ?? `Every ${m} min`

// A schedule is either a fixed interval or a cron expression — label it accordingly.
const scheduleLabel = (s: Schedule) =>
  s.cron_expr ? describeCron(s.cron_expr) ?? s.cron_expr : intervalLabel(s.interval_minutes)

// Short human date in a specific timezone, for the "next runs" preview.
const fmtInTz = (d: Date, tz: string) => {
  try {
    return d.toLocaleString('en-US', {
      timeZone: tz || 'UTC',
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    })
  } catch {
    return d.toISOString()
  }
}

export default function AgentsPage() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const [agents, setAgents] = useState<Agent[]>([])
  const [tools, setTools] = useState<Tool[]>([])
  const [collections, setCollections] = useState<Collection[]>([])
  const [members, setMembers] = useState<Record<string, Set<string>>>({}) // collection_id -> agent ids
  const [activeCollection, setActiveCollection] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<Agent | null>(null)
  const [schedules, setSchedules] = useState<Schedule[]>([])
  const [filterActive, setFilterActive] = useState<'all' | 'active' | 'inactive'>('all')
  const [filterScheduled, setFilterScheduled] = useState<'all' | 'scheduled' | 'unscheduled'>('all')
  const [search, setSearch] = useState('')
  const [searchResults, setSearchResults] = useState<Agent[] | null>(null)

  const load = useCallback(async () => {
    const [{ data: a }, { data: t }, { data: c }, { data: m }, { data: s }] = await Promise.all([
      supabase.from('agents').select('*').order('updated_at', { ascending: false }),
      supabase.from('tools').select('*').eq('is_active', true),
      supabase.from('collections').select('*').order('name', { ascending: true }),
      supabase.from('collection_agents').select('collection_id, agent_id'),
      supabase.from('schedules').select('*').eq('is_active', true),
    ])
    setAgents(a ?? [])
    setTools(t ?? [])
    setCollections(c ?? [])
    setSchedules(s ?? [])
    const map: Record<string, Set<string>> = {}
    for (const row of m ?? []) {
      const set = (map[row.collection_id] ??= new Set())
      set.add(row.agent_id)
    }
    setMembers(map)
    setLoading(false)
  }, [])

  useEffect(() => {
    load()
  }, [load])

  // Debounced search by name, description, or instructions
  useEffect(() => {
    const term = search.trim()
    if (!term) {
      setSearchResults(null)
      return
    }
    const handle = setTimeout(async () => {
      const pattern = `%${term.replace(/[,()\\%]/g, ' ')}%`
      const { data } = await supabase
        .from('agents')
        .select('*')
        .or(`name.ilike.${pattern},description.ilike.${pattern},instructions.ilike.${pattern}`)
        .order('updated_at', { ascending: false })
        .limit(200)
      setSearchResults(data ?? [])
    }, 250)
    return () => clearTimeout(handle)
  }, [search])

  const selectedIds = useMemo(() => [...selected], [selected])

  // Counts drive the picker's numbers and hide the empty collections.
  const collectionCounts = useMemo(() => {
    const out: Record<string, number> = {}
    for (const c of collections) out[c.id] = (members[c.id] ?? new Set()).size
    return out
  }, [collections, members])

  const scheduledAgentIds = useMemo(() => {
    const ids = new Set<string>()
    schedules.forEach((s) => ids.add(s.agent_id))
    return ids
  }, [schedules])

  const visible = useMemo(() => {
    // Use search results if search is active, otherwise all agents
    let filtered = searchResults ?? agents

    // Filter by collection
    if (activeCollection) {
      const set = members[activeCollection] ?? new Set()
      filtered = filtered.filter((a) => set.has(a.id))
    }

    // Filter by active status
    if (filterActive === 'active') {
      filtered = filtered.filter((a) => a.is_active)
    } else if (filterActive === 'inactive') {
      filtered = filtered.filter((a) => !a.is_active)
    }

    // Filter by scheduled status
    if (filterScheduled === 'scheduled') {
      filtered = filtered.filter((a) => scheduledAgentIds.has(a.id))
    } else if (filterScheduled === 'unscheduled') {
      filtered = filtered.filter((a) => !scheduledAgentIds.has(a.id))
    }

    return filtered
  }, [agents, searchResults, members, activeCollection, filterActive, filterScheduled, scheduledAgentIds])

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

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
          <h1 className="text-2xl font-semibold tracking-tight text-text">Agents</h1>
          <button
            onClick={create}
            className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white hover:bg-primary-strong"
          >
            <PlusIcon className="h-4 w-4" /> New agent
          </button>
        </div>
        <p className="mb-4 text-sm text-muted">
          An agent bundles a system prompt with the tools it may use. Build them here, or have an
          external Claude build them over MCP (Settings → Connect Claude).
        </p>

        {/* Search */}
        <div className="relative mb-5">
          <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-faint" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search agents by name, description, or instructions…"
            className="w-full rounded-lg border border-border-strong bg-surface py-2 pl-9 pr-9 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary-soft"
          />
          {search && (
            <button
              onClick={() => setSearch('')}
              aria-label="Clear search"
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1 text-faint transition hover:bg-surface-hover hover:text-text"
            >
              <CloseIcon className="h-4 w-4" />
            </button>
          )}
        </div>

        {/* Filters */}
        <div className="mb-5 space-y-3">
          {/* Status filters */}
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-medium text-muted">Status:</span>
            <button
              onClick={() => setFilterActive('all')}
              className={`rounded-full border px-3 py-1.5 text-sm font-medium transition ${
                filterActive === 'all'
                  ? 'border-primary bg-primary-soft text-primary'
                  : 'border-border text-muted hover:bg-surface-hover'
              }`}
            >
              All
            </button>
            <button
              onClick={() => setFilterActive('active')}
              className={`rounded-full border px-3 py-1.5 text-sm font-medium transition ${
                filterActive === 'active'
                  ? 'border-primary bg-primary-soft text-primary'
                  : 'border-border text-muted hover:bg-surface-hover'
              }`}
            >
              Active
            </button>
            <button
              onClick={() => setFilterActive('inactive')}
              className={`rounded-full border px-3 py-1.5 text-sm font-medium transition ${
                filterActive === 'inactive'
                  ? 'border-primary bg-primary-soft text-primary'
                  : 'border-border text-muted hover:bg-surface-hover'
              }`}
            >
              Inactive
            </button>
            <span className="mx-2 text-xs font-medium text-muted">Schedules:</span>
            <button
              onClick={() => setFilterScheduled('all')}
              className={`rounded-full border px-3 py-1.5 text-sm font-medium transition ${
                filterScheduled === 'all'
                  ? 'border-primary bg-primary-soft text-primary'
                  : 'border-border text-muted hover:bg-surface-hover'
              }`}
            >
              All
            </button>
            <button
              onClick={() => setFilterScheduled('scheduled')}
              className={`rounded-full border px-3 py-1.5 text-sm font-medium transition ${
                filterScheduled === 'scheduled'
                  ? 'border-primary bg-primary-soft text-primary'
                  : 'border-border text-muted hover:bg-surface-hover'
              }`}
            >
              Scheduled
            </button>
            <button
              onClick={() => setFilterScheduled('unscheduled')}
              className={`rounded-full border px-3 py-1.5 text-sm font-medium transition ${
                filterScheduled === 'unscheduled'
                  ? 'border-primary bg-primary-soft text-primary'
                  : 'border-border text-muted hover:bg-surface-hover'
              }`}
            >
              Unscheduled
            </button>
          </div>

          {/* Collection filter — one searchable control (see CollectionPicker). */}
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-medium text-muted">Collection:</span>
            <CollectionPicker
              collections={collections}
              selected={activeCollection ? new Set([activeCollection]) : EMPTY_SELECTION}
              onChange={(next) => setActiveCollection([...next][0] ?? null)}
              counts={collectionCounts}
              mode="single"
              totalLabel={String(agents.length)}
            />
          </div>
        </div>

        {loading ? (
          <p className="text-sm text-faint">Loading…</p>
        ) : visible.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-border-strong py-16 text-center">
            <AgentIcon className="mx-auto mb-3 h-8 w-8 text-faint" />
            <p className="text-sm text-muted">
              {activeCollection ? 'No agents in this collection yet.' : 'No agents yet. Create one, or build one from Claude over MCP.'}
            </p>
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {visible.map((a) => (
              <div
                key={a.id}
                className={`flex flex-col rounded-xl border bg-surface p-4 transition ${
                  selected.has(a.id) ? 'border-primary' : 'border-border'
                }`}
              >
                <div className="flex items-center gap-2">
                  <AgentIcon className="h-5 w-5 shrink-0 text-primary" />
                  <span className="min-w-0 flex-1 truncate font-medium text-text">{a.name}</span>
                  {scheduledAgentIds.has(a.id) && (
                    <div
                      className="h-2.5 w-2.5 shrink-0 rounded-full bg-emerald-500"
                      title="Agent has active schedules"
                    />
                  )}
                  {!a.is_active && <span className="text-[10px] uppercase text-faint">off</span>}
                  <button
                    onClick={() => toggleSelect(a.id)}
                    title="Select to add to a collection"
                    aria-label="Select agent"
                    className={`shrink-0 rounded-md p-1 hover:bg-surface-hover ${
                      selected.has(a.id) ? 'text-primary' : 'text-faint hover:text-muted'
                    }`}
                  >
                    <CheckIcon className="h-4 w-4" />
                  </button>
                </div>
                <p className="mt-1 line-clamp-2 text-xs text-muted">
                  {a.description || a.instructions.slice(0, 100) || 'No description'}
                </p>
                {(() => {
                  const agentSchedules = schedules.filter((s) => s.agent_id === a.id)
                  return agentSchedules.length > 0 ? (
                    <div className="mt-2 space-y-0.5">
                      {agentSchedules.map((s) => (
                        <p key={s.id} className="text-[11px] text-faint">
                          {scheduleLabel(s)}
                          {s.cron_expr && s.timezone && s.timezone !== 'UTC' && (
                            <span className="ml-1">({s.timezone})</span>
                          )}
                        </p>
                      ))}
                    </div>
                  ) : (
                    <p className="mt-2 text-[11px] text-faint">{formatDate(a.updated_at)}</p>
                  )
                })()}
                <div className="mt-3 flex gap-2">
                  <button
                    onClick={() => navigate(`/chat?agent=${a.id}&run=1`)}
                    title="Run the agent's task now"
                    className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-white hover:bg-primary-strong"
                  >
                    <PlayIcon className="h-3.5 w-3.5" /> Run
                  </button>
                  <button
                    onClick={() => navigate(`/agents/${a.id}`)}
                    title="See this agent's runs, tool calls, and outcomes"
                    className="flex items-center gap-1.5 rounded-lg border border-border-strong px-3 py-1.5 text-xs font-medium text-muted hover:bg-surface-hover"
                  >
                    <ActivityIcon className="h-3.5 w-3.5" /> Runs
                  </button>
                  <button
                    onClick={() => navigate(`/chat?agent=${a.id}`)}
                    title="Chat with the agent"
                    className="flex items-center gap-1.5 rounded-lg border border-border-strong px-3 py-1.5 text-xs font-medium text-muted hover:bg-surface-hover"
                  >
                    <ChatIcon className="h-3.5 w-3.5" /> Chat
                  </button>
                  <button
                    onClick={() => setEditing(a)}
                    className="rounded-lg border border-border-strong px-3 py-1.5 text-xs font-medium text-muted hover:bg-surface-hover"
                  >
                    Edit
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <AddToCollectionBar kind="agent" selectedIds={selectedIds} onClear={() => setSelected(new Set())} />

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
  const { user } = useAuth()
  const navigate = useNavigate()
  const [name, setName] = useState(agent.name)
  const [description, setDescription] = useState(agent.description)
  const [instructions, setInstructions] = useState(agent.instructions)
  const [toolIds, setToolIds] = useState<string[]>(agent.tool_ids)
  const [collections, setCollections] = useState<Collection[]>([])
  const [collectionIds, setCollectionIds] = useState<string[]>(agent.collection_ids ?? [])
  const [isActive, setIsActive] = useState(agent.is_active)
  const [saving, setSaving] = useState(false)
  const [schedules, setSchedules] = useState<Schedule[]>([])
  const [schedMode, setSchedMode] = useState<'preset' | 'cron'>('preset')
  const [newInterval, setNewInterval] = useState(1440)
  const [newCron, setNewCron] = useState('')
  const [newTimezone, setNewTimezone] = useState(localTimezone())
  const [showCronHelp, setShowCronHelp] = useState(false)
  const [newInput, setNewInput] = useState('')
  const [cronNaturalLang, setCronNaturalLang] = useState('')
  const [generatingCron, setGeneratingCron] = useState(false)

  // --- "/" skill autocomplete in the instructions field ---
  const [skills, setSkills] = useState<Skill[]>([])
  const [slashQuery, setSlashQuery] = useState<string | null>(null)
  const instrRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    supabase
      .from('skills')
      .select('*')
      .eq('is_builtin', false)
      .is('deleted_at', null)
      .order('name')
      .then(({ data }) => setSkills(data ?? []))
  }, [])

  useEffect(() => {
    supabase
      .from('collections')
      .select('*')
      .order('name')
      .then(({ data }) => setCollections(data ?? []))
  }, [])

  // Default a new schedule's timezone to the workspace timezone (Settings →
  // Timezone) rather than this browser's, so schedules created from any device
  // fire on the team's clock. Falls back to the browser zone until it loads.
  useEffect(() => {
    supabase
      .from('workspace_settings')
      .select('value')
      .eq('key', 'timezone')
      .maybeSingle()
      .then(({ data }) => {
        if (data?.value) setNewTimezone(data.value)
      })
  }, [])

  function detectSlash(el: HTMLTextAreaElement) {
    const before = el.value.slice(0, el.selectionStart)
    const m = before.match(/(?:^|\s)\/(\w*)$/)
    setSlashQuery(m ? m[1].toLowerCase() : null)
  }

  function insertSkill(s: Skill) {
    const el = instrRef.current
    if (!el) return
    const pos = el.selectionStart
    const head = instructions.slice(0, pos).replace(/\/(\w*)$/, '')
    const tail = instructions.slice(pos)
    const next = `${head}${s.instructions}${tail}`
    setInstructions(next)
    setSlashQuery(null)
    requestAnimationFrame(() => {
      el.focus()
      const caret = head.length + s.instructions.length
      el.setSelectionRange(caret, caret)
    })
  }

  const skillMatches =
    slashQuery !== null ? skills.filter((s) => s.name.toLowerCase().includes(slashQuery)).slice(0, 6) : []

  const loadSchedules = useCallback(async () => {
    const { data } = await supabase
      .from('schedules')
      .select('*')
      .eq('agent_id', agent.id)
      .order('created_at', { ascending: false })
    setSchedules(data ?? [])
  }, [agent.id])

  useEffect(() => {
    loadSchedules()
  }, [loadSchedules])

  async function addSchedule() {
    if (schedMode === 'cron') {
      const expr = newCron.trim()
      const runs = nextCronRuns(expr, newTimezone, 1)
      if (!isValidCron(expr) || !runs.length) return
      await supabase.from('schedules').insert({
        owner_id: user!.id,
        agent_id: agent.id,
        input: newInput,
        cron_expr: expr,
        timezone: newTimezone || 'UTC',
        next_run_at: runs[0].toISOString(),
      })
      setNewCron('')
    } else {
      await supabase.from('schedules').insert({
        owner_id: user!.id,
        agent_id: agent.id,
        input: newInput,
        interval_minutes: newInterval,
        next_run_at: new Date(Date.now() + newInterval * 60_000).toISOString(),
      })
    }
    setNewInput('')
    loadSchedules()
  }

  async function toggleSchedule(s: Schedule) {
    await supabase.from('schedules').update({ is_active: !s.is_active }).eq('id', s.id)
    loadSchedules()
  }

  async function removeSchedule(id: string) {
    await supabase.from('schedules').delete().eq('id', id)
    loadSchedules()
  }

  async function generateCronFromNaturalLanguage() {
    if (!cronNaturalLang.trim()) return
    setGeneratingCron(true)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) {
        alert('You must be signed in to use this feature')
        return
      }

      const response = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/cron-helper`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${session.access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ text: cronNaturalLang }),
      })

      if (!response.ok) {
        const error = await response.json().catch(() => ({ error: 'Failed to generate cron expression' }))
        alert(error.error || 'Failed to generate cron expression')
        return
      }

      const { cron } = await response.json()
      setNewCron(cron)
      setCronNaturalLang('')
    } catch (err) {
      console.error('Error generating cron:', err)
      alert('Failed to generate cron expression')
    } finally {
      setGeneratingCron(false)
    }
  }

  function toggleCollection(id: string) {
    setCollectionIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
  }

  function toggleTool(id: string) {
    setToolIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
  }

  const toolIdList = tools.map((t) => t.id)
  const allToolsSelected = allSelected(toolIdList, toolIds)

  async function save() {
    setSaving(true)
    await supabase
      .from('agents')
      .update({
        name,
        description,
        instructions,
        tool_ids: toolIds,
        collection_ids: collectionIds,
        is_active: isActive,
        updated_at: new Date().toISOString(),
      })
      .eq('id', agent.id)
    setSaving(false)
    onSaved()
  }

  async function saveAndRun() {
    await save()
    navigate(`/chat?agent=${agent.id}&run=1`)
  }

  async function remove() {
    if (!confirm(`Delete agent “${agent.name}”?`)) return
    await supabase.from('agents').delete().eq('id', agent.id)
    onSaved()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/40 sm:items-center sm:p-4">
      <div className="flex max-h-[92vh] w-full max-w-lg flex-col overflow-hidden rounded-t-2xl bg-surface shadow-xl sm:rounded-2xl">
        <div className="flex items-center justify-between border-b border-border px-5 py-3">
          <h2 className="text-sm font-semibold text-text">Agent</h2>
          <button
            onClick={remove}
            className="rounded-md p-1.5 text-faint hover:bg-red-50 hover:text-red-600"
            title="Delete"
          >
            <TrashIcon className="h-[18px] w-[18px]" />
          </button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto p-5">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted">Name</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full rounded-lg border border-border-strong px-3 py-2 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary-soft"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted">Description (optional)</span>
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="w-full rounded-lg border border-border-strong px-3 py-2 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary-soft"
            />
          </label>

          <div className="block">
            <span className="mb-1 flex items-center justify-between text-xs font-medium text-muted">
              <span>Instructions (the agent’s system prompt)</span>
              <span className="font-normal text-faint">
                Type <code className="rounded bg-surface-2 px-1">/</code> to insert a skill
              </span>
            </span>
            <div className="relative">
              <textarea
                ref={instrRef}
                value={instructions}
                onChange={(e) => {
                  setInstructions(e.target.value)
                  detectSlash(e.target)
                }}
                onKeyUp={(e) => detectSlash(e.currentTarget)}
                onClick={(e) => detectSlash(e.currentTarget)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') setSlashQuery(null)
                }}
                rows={8}
                placeholder="You are a support triage agent. For each message, classify urgency and draft a reply…"
                className="w-full resize-y rounded-lg border border-border-strong px-3 py-2 font-mono text-[13px] leading-relaxed outline-none focus:border-primary focus:ring-2 focus:ring-primary-soft"
              />
              {slashQuery !== null && skillMatches.length > 0 && (
                <div className="absolute left-0 right-0 top-full z-10 mt-1 max-h-48 overflow-y-auto rounded-lg border border-border bg-surface shadow-lg">
                  {skillMatches.map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      onMouseDown={(e) => {
                        e.preventDefault()
                        insertSkill(s)
                      }}
                      className="flex w-full items-start gap-2 px-3 py-2 text-left hover:bg-surface-hover"
                    >
                      <SkillIcon className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium text-text">{s.name}</span>
                        {s.description && (
                          <span className="block truncate text-xs text-muted">{s.description}</span>
                        )}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div>
            <span className="mb-1 flex items-center justify-between text-xs font-medium text-muted">
              <span>Tools it may use</span>
              {tools.length > 0 && (
                <button
                  type="button"
                  onClick={() => setToolIds(toggleAllTools(toolIdList, toolIds))}
                  className="font-normal text-primary hover:underline"
                >
                  {allToolsSelected ? 'Clear all' : 'Select all'}
                </button>
              )}
            </span>
            {tools.length === 0 ? (
              <p className="text-xs text-faint">No active tools. Add some on the Tools page.</p>
            ) : (
              <div className="space-y-1">
                {tools.map((t) => (
                  <label key={t.id} className="flex items-center gap-2 text-sm text-text">
                    <input
                      type="checkbox"
                      checked={toolIds.includes(t.id)}
                      onChange={() => toggleTool(t.id)}
                      className="h-4 w-4 rounded border-border-strong text-primary focus:ring-brand-500"
                    />
                    <span className="font-mono text-xs">{t.kind === 'web' ? 'web_browsing' : t.name}</span>
                  </label>
                ))}
              </div>
            )}
          </div>

          <div>
            <span className="mb-1 block text-xs font-medium text-muted">Collections it can use</span>
            <p className="mb-1.5 text-xs text-faint">
              The content of these collections (artifacts, files, to-dos) is injected as context whenever
              the agent runs — in chat, on a schedule, or from a webhook.
            </p>
            {collections.length === 0 ? (
              <p className="text-xs text-faint">No collections yet. Create some on the Collections page.</p>
            ) : (
              <div className="space-y-1">
                {collections.map((c) => (
                  <label key={c.id} className="flex items-center gap-2 text-sm text-text">
                    <input
                      type="checkbox"
                      checked={collectionIds.includes(c.id)}
                      onChange={() => toggleCollection(c.id)}
                      className="h-4 w-4 rounded border-border-strong text-primary focus:ring-brand-500"
                    />
                    <span className="truncate">{c.name}</span>
                    {c.visibility === 'workspace' && (
                      <span className="text-[10px] uppercase tracking-wide text-faint">shared</span>
                    )}
                  </label>
                ))}
              </div>
            )}
          </div>

          <div>
            <span className="block text-xs font-medium text-muted">Schedules</span>
            <p className="mb-2 mt-0.5 text-xs text-faint">
              Run this agent on its own, on a repeat — pick a preset interval, or switch to <b>Cron</b> for
              exact times like the 15th of the month or the last day of the month. Each run uses the agent's
              own instructions above; the optional note just adds extra direction for that run. Each run
              shows up in Activity.
            </p>
            <div className="space-y-1">
              {schedules.map((s) => (
                <div
                  key={s.id}
                  className="flex items-center gap-2 rounded-lg border border-border px-2 py-1.5 text-xs"
                >
                  <button
                    onClick={() => toggleSchedule(s)}
                    title={s.is_active ? 'Active — tap to pause' : 'Paused — tap to activate'}
                    className={`h-2.5 w-2.5 shrink-0 rounded-full ${s.is_active ? 'bg-emerald-500' : 'bg-border-strong'}`}
                  />
                  <span
                    className="shrink-0 font-medium text-muted"
                    title={s.cron_expr ? `${s.cron_expr} · ${s.timezone}` : undefined}
                  >
                    {scheduleLabel(s)}
                    {s.cron_expr && <span className="ml-1 font-normal text-faint">({s.timezone})</span>}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-muted">{s.input || '(no input)'}</span>
                  <button onClick={() => removeSchedule(s.id)} className="text-faint hover:text-red-600">
                    <TrashIcon className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>
            <div className="mt-2 space-y-2">
              {/* Preset / Cron mode toggle */}
              <div className="inline-flex rounded-lg border border-border-strong p-0.5 text-xs">
                {(['preset', 'cron'] as const).map((m) => (
                  <button
                    key={m}
                    onClick={() => setSchedMode(m)}
                    className={`rounded-md px-2.5 py-1 font-medium capitalize ${
                      schedMode === m ? 'bg-primary text-white' : 'text-muted hover:bg-surface-hover'
                    }`}
                  >
                    {m}
                  </button>
                ))}
              </div>

              {schedMode === 'preset' ? (
                <div className="flex flex-col gap-2 sm:flex-row">
                  <select
                    value={newInterval}
                    onChange={(e) => setNewInterval(Number(e.target.value))}
                    className="w-full rounded-lg border border-border-strong px-2 py-1.5 text-xs sm:w-auto"
                  >
                    {INTERVALS.map((i) => (
                      <option key={i.minutes} value={i.minutes}>
                        {i.label}
                      </option>
                    ))}
                  </select>
                  <input
                    value={newInput}
                    onChange={(e) => setNewInput(e.target.value)}
                    placeholder="Optional — extra direction for this run (defaults to the agent's instructions)"
                    className="w-full rounded-lg border border-border-strong px-2 py-1.5 text-xs outline-none focus:border-primary sm:flex-1"
                  />
                  <button
                    onClick={addSchedule}
                    className="w-full rounded-lg bg-slate-800 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-700 disabled:opacity-50 sm:w-auto"
                  >
                    Add schedule
                  </button>
                </div>
              ) : (
                <div className="space-y-2">
                  {/* Natural language input for AI-assisted cron generation */}
                  <div className="rounded-lg border border-primary-soft bg-primary-soft/20 p-2">
                    <p className="mb-1.5 text-xs font-medium text-muted">
                      Describe your schedule in plain English
                    </p>
                    <div className="flex flex-col gap-2 sm:flex-row">
                      <input
                        value={cronNaturalLang}
                        onChange={(e) => setCronNaturalLang(e.target.value)}
                        placeholder='e.g., "Friday 7am", "Every weekday at 9am", "15th of every month at 2pm"'
                        disabled={generatingCron}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && !generatingCron && cronNaturalLang.trim()) {
                            generateCronFromNaturalLanguage()
                          }
                        }}
                        className="w-full rounded-lg border border-border-strong px-2 py-1.5 text-xs outline-none focus:border-primary disabled:opacity-50 sm:flex-1"
                      />
                      <button
                        onClick={generateCronFromNaturalLanguage}
                        disabled={!cronNaturalLang.trim() || generatingCron}
                        className="rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-white hover:bg-primary-strong disabled:opacity-50"
                      >
                        {generatingCron ? 'Generating…' : 'Generate cron'}
                      </button>
                    </div>
                  </div>

                  {/* Manual cron expression input */}
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <input
                      value={newCron}
                      onChange={(e) => setNewCron(e.target.value)}
                      placeholder="0 9 15 * *"
                      spellCheck={false}
                      className="w-full rounded-lg border border-border-strong px-2 py-1.5 font-mono text-xs outline-none focus:border-primary sm:flex-1"
                    />
                    <input
                      value={newTimezone}
                      onChange={(e) => setNewTimezone(e.target.value)}
                      placeholder="Timezone (IANA)"
                      spellCheck={false}
                      title="IANA timezone, e.g. America/New_York"
                      className="w-full rounded-lg border border-border-strong px-2 py-1.5 text-xs outline-none focus:border-primary sm:w-48"
                    />
                  </div>

                  {/* Live validation + next-runs preview */}
                  {newCron.trim() &&
                    (isValidCron(newCron) ? (
                      <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-2 py-1.5 text-xs text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300">
                        <div className="font-medium">{describeCron(newCron)}</div>
                        {nextCronRuns(newCron, newTimezone, 3).length > 0 && (
                          <div className="mt-0.5 text-emerald-700/80 dark:text-emerald-400/80">
                            Next: {nextCronRuns(newCron, newTimezone, 3).map((d) => fmtInTz(d, newTimezone)).join(' · ')}
                          </div>
                        )}
                      </div>
                    ) : (
                      <div className="rounded-lg border border-red-200 bg-red-50 px-2 py-1.5 text-xs text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
                        Not a valid 5-field cron expression.
                      </div>
                    ))}

                  <input
                    value={newInput}
                    onChange={(e) => setNewInput(e.target.value)}
                    placeholder="Optional — extra direction for this run (defaults to the agent's instructions)"
                    className="w-full rounded-lg border border-border-strong px-2 py-1.5 text-xs outline-none focus:border-primary"
                  />

                  <div className="flex items-center justify-between">
                    <button
                      onClick={() => setShowCronHelp((v) => !v)}
                      className="text-xs font-medium text-muted hover:text-text"
                    >
                      {showCronHelp ? 'Hide' : 'Cron'} syntax
                    </button>
                    <button
                      onClick={addSchedule}
                      disabled={!isValidCron(newCron)}
                      className="rounded-lg bg-slate-800 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-700 disabled:opacity-50"
                    >
                      Add schedule
                    </button>
                  </div>

                  {showCronHelp && (
                    <div className="rounded-lg border border-border bg-surface-muted px-3 py-2 text-xs text-muted">
                      <p className="mb-1.5">
                        Five fields, space-separated. <code>*</code> means “every”. Ranges (<code>1-5</code>),
                        lists (<code>1,15</code>) and steps (<code>*/2</code>) work. <code>L</code> in the day
                        field means the last day of the month.
                      </p>
                      <pre className="mb-2 overflow-x-auto font-mono text-[11px] leading-tight text-faint">
{`┌───────── minute (0-59)
│ ┌─────── hour (0-23)
│ │ ┌───── day of month (1-31, or L)
│ │ │ ┌─── month (1-12)
│ │ │ │ ┌─ day of week (0-6, Sun=0)
│ │ │ │ │
* * * * *`}
                      </pre>
                      <div className="flex flex-wrap gap-1">
                        {CRON_EXAMPLES.map((ex) => (
                          <button
                            key={ex.expr}
                            onClick={() => setNewCron(ex.expr)}
                            title={ex.expr}
                            className="rounded-md border border-border-strong bg-surface px-1.5 py-0.5 hover:border-primary"
                          >
                            <span className="font-mono">{ex.expr}</span>
                            <span className="ml-1 text-faint">— {ex.label}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

          <label className="flex items-center gap-2 text-sm text-text">
            <input
              type="checkbox"
              checked={isActive}
              onChange={(e) => setIsActive(e.target.checked)}
              className="h-4 w-4 rounded border-border-strong text-primary focus:ring-brand-500"
            />
            Active
          </label>
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-border px-5 py-3">
          <button
            onClick={saveAndRun}
            disabled={saving || !name.trim()}
            className="flex items-center gap-1.5 rounded-lg border border-border-strong px-3 py-2 text-sm font-medium text-text hover:bg-surface-hover disabled:opacity-50"
            title="Save, then run the agent now"
          >
            <PlayIcon className="h-4 w-4" /> Run
          </button>
          <div className="flex gap-2">
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
    </div>
  )
}
