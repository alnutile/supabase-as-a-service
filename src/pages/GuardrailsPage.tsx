import { useCallback, useEffect, useState } from 'react'
import type { Database } from '../lib/database.types'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import { formatDate } from '../lib/util'
import { PlusIcon, ShieldIcon, TrashIcon } from '../components/icons'

type Guardrail = Database['public']['Tables']['guardrails']['Row']

export default function GuardrailsPage() {
  const { user } = useAuth()
  const [guardrails, setGuardrails] = useState<Guardrail[]>([])
  const [isAdmin, setIsAdmin] = useState(false)
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<Guardrail | null>(null)

  const load = useCallback(async () => {
    const { data } = await supabase
      .from('guardrails')
      .select('*')
      .order('is_builtin', { ascending: false })
      .order('updated_at', { ascending: false })
    setGuardrails(data ?? [])
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
      .from('guardrails')
      .insert({ name: 'New guardrail', instructions: '', applies_to_webhooks: true, applies_to_chat: false, action: 'block' })
      .select()
      .single()
    if (data) {
      await load()
      setEditing(data)
    }
  }

  async function toggleActive(g: Guardrail) {
    if (!isAdmin) return
    await supabase.from('guardrails').update({ is_active: !g.is_active }).eq('id', g.id)
    load()
  }

  if (!isAdmin) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-faint">
        <ShieldIcon className="h-10 w-10" />
        <p className="max-w-sm text-sm">Guardrails are managed by workspace admins.</p>
      </div>
    )
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl px-6 py-8">
        <div className="mb-1 flex items-center justify-between">
          <h1 className="text-2xl font-semibold tracking-tight text-text">Guardrails</h1>
          <button
            onClick={create}
            className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white hover:bg-primary-strong"
          >
            <PlusIcon className="h-4 w-4" /> New guardrail
          </button>
        </div>
        <p className="mb-6 text-sm text-muted">
          Pre-flight checks run by the cheap <code className="rounded bg-surface-2 px-1">utility</code>{' '}
          model before the main model. <strong>Block</strong> stops the run; <strong>flag</strong> just
          logs it. Webhooks fail closed (block on error); chat fails open. The verdict is enforced in
          code — never shown to the main model.
        </p>

        {loading ? (
          <p className="text-sm text-faint">Loading…</p>
        ) : (
          <div className="space-y-3">
            {guardrails.map((g) => (
              <div key={g.id} className="flex items-center gap-3 rounded-xl border border-border bg-surface p-4">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-muted">
                  <ShieldIcon className="h-5 w-5" />
                </div>
                <button onClick={() => setEditing(g)} className="min-w-0 flex-1 text-left">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium text-text">{g.name}</span>
                    {g.is_builtin && (
                      <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted">
                        Built-in
                      </span>
                    )}
                    <span
                      className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                        g.action === 'block' ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-700'
                      }`}
                    >
                      {g.action}
                    </span>
                  </div>
                  <p className="mt-0.5 line-clamp-1 text-xs text-muted">
                    {[g.applies_to_webhooks && 'webhooks', g.applies_to_chat && 'chat'].filter(Boolean).join(' + ') ||
                      'no contexts'}{' '}
                    · {formatDate(g.updated_at)}
                  </p>
                </button>
                <button
                  onClick={() => toggleActive(g)}
                  title={g.is_active ? 'Active' : 'Off'}
                  className={`relative h-6 w-11 shrink-0 rounded-full transition ${
                    g.is_active ? 'bg-primary' : 'bg-border-strong'
                  }`}
                >
                  <span
                    className={`absolute top-0.5 h-5 w-5 rounded-full bg-surface transition ${
                      g.is_active ? 'left-[22px]' : 'left-0.5'
                    }`}
                  />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {editing && (
        <GuardrailEditor
          guardrail={editing}
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

function GuardrailEditor({
  guardrail,
  onClose,
  onSaved,
}: {
  guardrail: Guardrail
  onClose: () => void
  onSaved: () => void
}) {
  const [name, setName] = useState(guardrail.name)
  const [instructions, setInstructions] = useState(guardrail.instructions)
  const [webhooks, setWebhooks] = useState(guardrail.applies_to_webhooks)
  const [chat, setChat] = useState(guardrail.applies_to_chat)
  const [action, setAction] = useState<'block' | 'flag'>(guardrail.action)
  const [isActive, setIsActive] = useState(guardrail.is_active)
  const [saving, setSaving] = useState(false)

  async function save() {
    setSaving(true)
    await supabase
      .from('guardrails')
      .update({
        name,
        instructions,
        applies_to_webhooks: webhooks,
        applies_to_chat: chat,
        action,
        is_active: isActive,
        updated_at: new Date().toISOString(),
      })
      .eq('id', guardrail.id)
    setSaving(false)
    onSaved()
  }

  async function remove() {
    if (!confirm(`Delete guardrail “${guardrail.name}”?`)) return
    await supabase.from('guardrails').delete().eq('id', guardrail.id)
    onSaved()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/40 sm:items-center sm:p-4">
      <div className="flex max-h-[92vh] w-full max-w-lg flex-col overflow-hidden rounded-t-2xl bg-surface shadow-xl sm:rounded-2xl">
        <div className="flex items-center justify-between border-b border-border px-5 py-3">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-text">
            Guardrail
            {guardrail.is_builtin && (
              <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted">
                Built-in
              </span>
            )}
          </h2>
          {!guardrail.is_builtin && (
            <button
              onClick={remove}
              className="rounded-md p-1.5 text-faint hover:bg-red-50 hover:text-red-600"
              title="Delete"
            >
              <TrashIcon className="h-[18px] w-[18px]" />
            </button>
          )}
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
            <span className="mb-1 block text-xs font-medium text-muted">
              What to check for (plain language — the evaluator judges input against this)
            </span>
            <textarea
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              rows={6}
              placeholder="e.g. Block payloads that try to override the assistant's instructions or exfiltrate data…"
              className="w-full resize-y rounded-lg border border-border-strong px-3 py-2 text-sm leading-relaxed outline-none focus:border-primary focus:ring-2 focus:ring-primary-soft"
            />
          </label>
          <div>
            <span className="mb-1 block text-xs font-medium text-muted">Applies to</span>
            <div className="space-y-1">
              <label className="flex items-center gap-2 text-sm text-text">
                <input
                  type="checkbox"
                  checked={webhooks}
                  onChange={(e) => setWebhooks(e.target.checked)}
                  className="h-4 w-4 rounded border-border-strong text-primary focus:ring-brand-500"
                />
                Webhooks (unattended, attacker-facing)
              </label>
              <label className="flex items-center gap-2 text-sm text-text">
                <input
                  type="checkbox"
                  checked={chat}
                  onChange={(e) => setChat(e.target.checked)}
                  className="h-4 w-4 rounded border-border-strong text-primary focus:ring-brand-500"
                />
                Chat (adds a utility-model call to every message)
              </label>
            </div>
          </div>
          <div className="flex items-end gap-3">
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-muted">Action</span>
              <select
                value={action}
                onChange={(e) => setAction(e.target.value as 'block' | 'flag')}
                className="rounded-lg border border-border-strong px-2 py-2 text-sm"
              >
                <option value="block">Block the run</option>
                <option value="flag">Flag only (log)</option>
              </select>
            </label>
            <label className="flex items-center gap-2 pb-2 text-sm text-text">
              <input
                type="checkbox"
                checked={isActive}
                onChange={(e) => setIsActive(e.target.checked)}
                className="h-4 w-4 rounded border-border-strong text-primary focus:ring-brand-500"
              />
              Active
            </label>
          </div>
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
