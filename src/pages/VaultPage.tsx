import { useCallback, useEffect, useState } from 'react'
import type { Database } from '../lib/database.types'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import { formatDate } from '../lib/util'
import { LockIcon, PlusIcon, TrashIcon } from '../components/icons'

type Secret = Database['public']['Tables']['vault_secrets']['Row']

export default function VaultPage() {
  const { user } = useAuth()
  const [secrets, setSecrets] = useState<Secret[]>([])
  const [isAdmin, setIsAdmin] = useState(false)
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<Secret | 'new' | null>(null)

  const load = useCallback(async () => {
    const { data } = await supabase
      .from('vault_secrets')
      .select('*')
      .order('name', { ascending: true })
    setSecrets(data ?? [])
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

  if (!isAdmin) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-faint">
        <LockIcon className="h-10 w-10" />
        <p className="max-w-sm text-sm">The secrets vault is managed by workspace admins.</p>
      </div>
    )
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl px-6 py-8">
        <div className="mb-1 flex items-center justify-between">
          <h1 className="text-2xl font-semibold tracking-tight text-text">Secrets</h1>
          <button
            onClick={() => setEditing('new')}
            className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white hover:bg-primary-strong"
          >
            <PlusIcon className="h-4 w-4" /> New secret
          </button>
        </div>
        <p className="mb-6 text-sm text-muted">
          Named secrets (API keys, tokens, passwords) stored encrypted in Supabase Vault. The value
          is never shown again after you save it. Mark a secret <strong>Workspace</strong> to share it
          with the team, or <strong>Private</strong> to keep it to yourself. The assistant can fetch a
          secret on demand with the <code className="rounded bg-surface-2 px-1">get_secret</code> tool —
          treat anything you store here as readable by an agent you let use that tool.
        </p>

        {loading ? (
          <p className="text-sm text-faint">Loading…</p>
        ) : secrets.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border px-6 py-10 text-center text-sm text-faint">
            No secrets yet. Add one to share a credential with the team or the assistant.
          </p>
        ) : (
          <div className="space-y-3">
            {secrets.map((s) => (
              <div key={s.id} className="flex items-center gap-3 rounded-xl border border-border bg-surface p-4">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-muted">
                  <LockIcon className="h-5 w-5" />
                </div>
                <button onClick={() => setEditing(s)} className="min-w-0 flex-1 text-left">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-mono text-sm font-medium text-text">{s.name}</span>
                    <span
                      className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                        s.scope === 'workspace'
                          ? 'bg-emerald-100 text-emerald-700'
                          : 'bg-surface-2 text-muted'
                      }`}
                    >
                      {s.scope}
                    </span>
                  </div>
                  <p className="mt-0.5 line-clamp-1 text-xs text-muted">
                    {s.description || 'No description'} · {formatDate(s.updated_at)}
                  </p>
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {editing && (
        <SecretEditor
          secret={editing === 'new' ? null : editing}
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

function SecretEditor({
  secret,
  onClose,
  onSaved,
}: {
  secret: Secret | null
  onClose: () => void
  onSaved: () => void
}) {
  const [name, setName] = useState(secret?.name ?? '')
  const [description, setDescription] = useState(secret?.description ?? '')
  const [scope, setScope] = useState<'workspace' | 'private'>(
    (secret?.scope as 'workspace' | 'private') ?? 'workspace',
  )
  const [value, setValue] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function save() {
    setError(null)
    if (!name.trim()) {
      setError('A name is required.')
      return
    }
    if (!secret && !value.trim()) {
      setError('A value is required to create a secret.')
      return
    }
    setSaving(true)
    const { error: rpcError } = await supabase.rpc('set_vault_secret', {
      p_id: secret?.id ?? null,
      p_name: name.trim(),
      p_description: description.trim(),
      p_value: value.trim() || '', // empty = keep existing value (on edit)
      p_scope: scope,
    })
    setSaving(false)
    if (rpcError) {
      setError(rpcError.message)
      return
    }
    setValue('')
    onSaved()
  }

  async function remove() {
    if (!secret) return
    if (!confirm(`Delete secret “${secret.name}”? Anything relying on it will stop working.`)) return
    await supabase.rpc('delete_vault_secret', { p_id: secret.id })
    onSaved()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/40 sm:items-center sm:p-4">
      <div className="flex max-h-[92vh] w-full max-w-lg flex-col overflow-hidden rounded-t-2xl bg-surface shadow-xl sm:rounded-2xl">
        <div className="flex items-center justify-between border-b border-border px-5 py-3">
          <h2 className="text-sm font-semibold text-text">{secret ? 'Edit secret' : 'New secret'}</h2>
          {secret && (
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
            <span className="mb-1 block text-xs font-medium text-muted">
              Name (the key the assistant fetches by)
            </span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. stripe_api_key"
              className="w-full rounded-lg border border-border-strong px-3 py-2 font-mono text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary-soft"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted">Description (optional)</span>
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What it's for / where to use it"
              className="w-full rounded-lg border border-border-strong px-3 py-2 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary-soft"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted">
              {secret ? 'New value (leave blank to keep the current one)' : 'Value'}
            </span>
            <textarea
              value={value}
              onChange={(e) => setValue(e.target.value)}
              rows={3}
              placeholder={secret ? '••••••••  (unchanged)' : 'The secret value'}
              autoComplete="off"
              spellCheck={false}
              className="w-full resize-y rounded-lg border border-border-strong px-3 py-2 font-mono text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary-soft"
            />
            <span className="mt-1 block text-[11px] text-faint">
              Stored encrypted in Supabase Vault. You won't be able to read it back here.
            </span>
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted">Sharing</span>
            <select
              value={scope}
              onChange={(e) => setScope(e.target.value as 'workspace' | 'private')}
              className="rounded-lg border border-border-strong px-2 py-2 text-sm"
            >
              <option value="workspace">Workspace — shared with the whole team</option>
              <option value="private">Private — only me</option>
            </select>
          </label>

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
