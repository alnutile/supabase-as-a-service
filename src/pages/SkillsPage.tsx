import { useCallback, useEffect, useState } from 'react'
import type { ArtifactType, Database, SkillOutputMode } from '../lib/database.types'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import { formatDate } from '../lib/util'
import { ArtifactIcon, ChatIcon, PlusIcon, TrashIcon } from '../components/icons'

type Skill = Database['public']['Tables']['skills']['Row']

const ARTIFACT_TYPES: ArtifactType[] = ['markdown', 'code', 'html', 'text']

export default function SkillsPage() {
  const { user } = useAuth()
  const [skills, setSkills] = useState<Skill[]>([])
  const [isAdmin, setIsAdmin] = useState(false)
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<Skill | null>(null)

  const load = useCallback(async () => {
    const { data } = await supabase
      .from('skills')
      .select('*')
      .order('auto_apply', { ascending: false })
      .order('updated_at', { ascending: false })
    setSkills(data ?? [])
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

  async function create(autoApply: boolean) {
    const { data, error } = await supabase
      .from('skills')
      .insert({
        owner_id: user!.id,
        name: autoApply ? 'New always-on prompt' : 'New skill',
        instructions: '',
        auto_apply: autoApply,
        output_mode: autoApply ? 'reply' : 'artifact',
        artifact_type: 'markdown',
      })
      .select()
      .single()
    if (!error && data) {
      await load()
      setEditing(data)
    }
  }

  const alwaysOn = skills.filter((s) => s.auto_apply)
  const onDemand = skills.filter((s) => !s.auto_apply)

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-4xl px-6 py-8">
        <div className="mb-6 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-text">Prompts &amp; skills</h1>
            <p className="mt-1 text-sm text-muted">
              Always-on prompts shape every chat. On-demand skills run when you type{' '}
              <code className="rounded bg-surface-2 px-1">/</code>.
            </p>
          </div>
          <button
            onClick={() => create(false)}
            className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white transition hover:bg-primary-strong"
          >
            <PlusIcon className="h-4 w-4" /> New skill
          </button>
        </div>

        {loading ? (
          <p className="text-sm text-faint">Loading…</p>
        ) : (
          <div className="space-y-8">
            {/* Always-on */}
            <section>
              <div className="mb-2 flex items-center justify-between">
                <h2 className="text-xs font-semibold uppercase tracking-wide text-muted">
                  Always on · applied to every chat
                </h2>
                {isAdmin && (
                  <button
                    onClick={() => create(true)}
                    className="flex items-center gap-1 text-sm font-medium text-primary hover:underline"
                  >
                    <PlusIcon className="h-3.5 w-3.5" /> Add
                  </button>
                )}
              </div>
              {alwaysOn.length === 0 ? (
                <p className="rounded-xl border border-dashed border-border-strong py-8 text-center text-sm text-faint">
                  No always-on prompts yet.
                </p>
              ) : (
                <div className="grid gap-3 sm:grid-cols-2">
                  {alwaysOn.map((s) => (
                    <SkillCard key={s.id} skill={s} onClick={() => setEditing(s)} alwaysOn />
                  ))}
                </div>
              )}
              {!isAdmin && (
                <p className="mt-2 text-xs text-faint">
                  Only an admin can edit always-on prompts.
                </p>
              )}
            </section>

            {/* On-demand */}
            <section>
              <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">
                On demand · run with /
              </h2>
              {onDemand.length === 0 ? (
                <p className="rounded-xl border border-dashed border-border-strong py-8 text-center text-sm text-faint">
                  No skills yet. Create one to run it from chat.
                </p>
              ) : (
                <div className="grid gap-3 sm:grid-cols-2">
                  {onDemand.map((s) => (
                    <SkillCard key={s.id} skill={s} onClick={() => setEditing(s)} />
                  ))}
                </div>
              )}
            </section>
          </div>
        )}
      </div>

      {editing && (
        <SkillEditor
          skill={editing}
          canEdit={editing.auto_apply ? isAdmin : true}
          isAdmin={isAdmin}
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

function SkillCard({
  skill,
  onClick,
  alwaysOn,
}: {
  skill: Skill
  onClick: () => void
  alwaysOn?: boolean
}) {
  return (
    <button
      onClick={onClick}
      className="group rounded-xl border border-border bg-surface p-4 text-left transition hover:border-brand-300 hover:shadow-sm"
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="truncate font-medium text-text group-hover:text-primary">
          {skill.name}
        </h3>
        {skill.is_builtin ? (
          <span className="shrink-0 rounded-full bg-surface-2 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted">
            Built-in
          </span>
        ) : alwaysOn ? null : (
          <span className="flex shrink-0 items-center gap-1 text-[11px] text-faint">
            {skill.output_mode === 'artifact' ? (
              <>
                <ArtifactIcon className="h-3.5 w-3.5" /> {skill.artifact_type}
              </>
            ) : (
              <>
                <ChatIcon className="h-3.5 w-3.5" /> reply
              </>
            )}
          </span>
        )}
      </div>
      <p className="mt-1 line-clamp-2 text-xs text-muted">
        {skill.description || skill.instructions.slice(0, 120) || 'No description'}
      </p>
      <p className="mt-3 text-[11px] uppercase tracking-wide text-faint">
        Updated {formatDate(skill.updated_at)}
      </p>
    </button>
  )
}

function SkillEditor({
  skill,
  canEdit,
  isAdmin,
  onClose,
  onSaved,
}: {
  skill: Skill
  canEdit: boolean
  isAdmin: boolean
  onClose: () => void
  onSaved: () => void
}) {
  const [draft, setDraft] = useState(skill)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function save() {
    setSaving(true)
    setError(null)
    const { error: upErr } = await supabase
      .from('skills')
      .update({
        name: draft.name,
        description: draft.description,
        instructions: draft.instructions,
        auto_apply: draft.auto_apply,
        output_mode: draft.output_mode,
        artifact_type: draft.artifact_type,
        updated_at: new Date().toISOString(),
      })
      .eq('id', draft.id)
    setSaving(false)
    if (upErr) {
      setError(upErr.message)
      return
    }
    onSaved()
  }

  async function remove() {
    if (!confirm(`Delete “${draft.name}”?`)) return
    await supabase.from('skills').delete().eq('id', draft.id)
    onSaved()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/40 sm:items-center sm:p-4">
      <div className="flex max-h-[92vh] w-full max-w-lg flex-col overflow-hidden rounded-t-2xl bg-surface shadow-xl sm:rounded-2xl">
        <div className="flex items-center justify-between border-b border-border px-5 py-3">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-text">
            {draft.auto_apply ? 'Always-on prompt' : 'Skill'}
            {draft.is_builtin && (
              <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted">
                Built-in
              </span>
            )}
          </h2>
          {canEdit && (
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
          {!canEdit && (
            <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-700">
              Only an admin can edit always-on prompts. You can view it here.
            </p>
          )}

          <Field label="Name">
            <input
              value={draft.name}
              disabled={!canEdit}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              className="w-full rounded-lg border border-border-strong px-3 py-2 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary-soft disabled:bg-surface-2"
            />
          </Field>
          <Field label="Description (optional)">
            <input
              value={draft.description ?? ''}
              disabled={!canEdit}
              onChange={(e) => setDraft({ ...draft, description: e.target.value })}
              className="w-full rounded-lg border border-border-strong px-3 py-2 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary-soft disabled:bg-surface-2"
            />
          </Field>
          <Field label={draft.auto_apply ? 'Prompt (added to every chat)' : 'Instructions'}>
            <textarea
              value={draft.instructions}
              disabled={!canEdit}
              onChange={(e) => setDraft({ ...draft, instructions: e.target.value })}
              rows={10}
              placeholder={
                draft.auto_apply
                  ? 'e.g. This is Acme Co.’s intranet. We make widgets. Keep a friendly, professional tone…'
                  : 'Tell the model exactly what to do with the conversation context…'
              }
              className="w-full resize-y rounded-lg border border-border-strong px-3 py-2 font-mono text-[13px] leading-relaxed outline-none focus:border-primary focus:ring-2 focus:ring-primary-soft disabled:bg-surface-2"
            />
          </Field>

          {/* Always-on toggle (admins only) */}
          <label className={`flex items-center gap-2 text-sm ${isAdmin ? '' : 'opacity-60'}`}>
            <input
              type="checkbox"
              checked={draft.auto_apply}
              disabled={!isAdmin || !canEdit}
              onChange={(e) => setDraft({ ...draft, auto_apply: e.target.checked })}
              className="h-4 w-4 rounded border-border-strong text-primary focus:ring-brand-500"
            />
            <span className="text-text">Always on — apply to every chat</span>
            {!isAdmin && <span className="text-xs text-faint">(admin only)</span>}
          </label>

          {!draft.auto_apply && (
            <div className="flex gap-3">
              <Field label="Output">
                <select
                  value={draft.output_mode}
                  disabled={!canEdit}
                  onChange={(e) =>
                    setDraft({ ...draft, output_mode: e.target.value as SkillOutputMode })
                  }
                  className="w-full rounded-lg border border-border-strong px-2 py-2 text-sm disabled:bg-surface-2"
                >
                  <option value="artifact">Create artifact</option>
                  <option value="reply">Reply in chat</option>
                </select>
              </Field>
              {draft.output_mode === 'artifact' && (
                <Field label="Artifact type">
                  <select
                    value={draft.artifact_type}
                    disabled={!canEdit}
                    onChange={(e) =>
                      setDraft({ ...draft, artifact_type: e.target.value as ArtifactType })
                    }
                    className="w-full rounded-lg border border-border-strong px-2 py-2 text-sm disabled:bg-surface-2"
                  >
                    {ARTIFACT_TYPES.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </select>
                </Field>
              )}
            </div>
          )}

          {error && <p className="text-sm text-red-600">{error}</p>}
        </div>

        <div className="flex justify-end gap-2 border-t border-border px-5 py-3">
          <button
            onClick={onClose}
            className="rounded-lg px-3 py-2 text-sm font-medium text-muted hover:bg-surface-hover"
          >
            {canEdit ? 'Cancel' : 'Close'}
          </button>
          {canEdit && (
            <button
              onClick={save}
              disabled={saving || !draft.name.trim()}
              className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white hover:bg-primary-strong disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          )}
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
