import { useCallback, useEffect, useState } from 'react'
import type { ArtifactType, Database, SkillOutputMode } from '../lib/database.types'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import { formatDate } from '../lib/util'
import { ArtifactIcon, ChatIcon, PlusIcon, SkillIcon, TrashIcon } from '../components/icons'

type Skill = Database['public']['Tables']['skills']['Row']

const ARTIFACT_TYPES: ArtifactType[] = ['markdown', 'code', 'html', 'text']

const STARTER = {
  name: 'Generate Quote',
  description: 'Turn pasted context into a clean, shareable quote.',
  instructions: `You are a quoting assistant. Using the context provided in the conversation, produce a professional price quote.

Output a single clean Markdown document with:
- A short header (client, date, quote number if present)
- A line-item table (description, qty, unit price, amount)
- A total
- Brief terms / validity

Output only the quote — no preamble, no commentary.`,
  output_mode: 'artifact' as SkillOutputMode,
  artifact_type: 'markdown' as ArtifactType,
}

export default function SkillsPage() {
  const { user } = useAuth()
  const [skills, setSkills] = useState<Skill[]>([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<Skill | null>(null)

  const load = useCallback(async () => {
    const { data } = await supabase
      .from('skills')
      .select('*')
      .order('updated_at', { ascending: false })
    setSkills(data ?? [])
    setLoading(false)
  }, [])

  useEffect(() => {
    load()
  }, [load])

  async function createSkill(seed?: Partial<Skill>) {
    const { data, error } = await supabase
      .from('skills')
      .insert({
        owner_id: user!.id,
        name: seed?.name ?? 'New skill',
        description: seed?.description ?? null,
        instructions: seed?.instructions ?? '',
        output_mode: seed?.output_mode ?? 'artifact',
        artifact_type: seed?.artifact_type ?? 'markdown',
      })
      .select()
      .single()
    if (!error && data) {
      await load()
      setEditing(data)
    }
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-4xl px-6 py-8">
        <div className="mb-6 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-slate-900">Skills</h1>
            <p className="mt-1 text-sm text-slate-500">
              Reusable instructions you can run from chat with <code className="rounded bg-slate-100 px-1">/</code>.
            </p>
          </div>
          <button
            onClick={() => createSkill()}
            className="flex items-center gap-2 rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-brand-700"
          >
            <PlusIcon className="h-4 w-4" /> New skill
          </button>
        </div>

        {loading ? (
          <p className="text-sm text-slate-400">Loading…</p>
        ) : skills.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-slate-300 py-16 text-center">
            <SkillIcon className="mx-auto mb-3 h-8 w-8 text-slate-300" />
            <p className="text-sm text-slate-500">No skills yet.</p>
            <button
              onClick={() => createSkill(STARTER)}
              className="mt-3 text-sm font-medium text-brand-600 hover:underline"
            >
              Create a starter “Generate Quote” skill
            </button>
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {skills.map((s) => (
              <button
                key={s.id}
                onClick={() => setEditing(s)}
                className="group rounded-xl border border-slate-200 bg-white p-4 text-left transition hover:border-brand-300 hover:shadow-sm"
              >
                <div className="flex items-center justify-between">
                  <h3 className="truncate font-medium text-slate-800 group-hover:text-brand-700">
                    {s.name}
                  </h3>
                  <span className="flex items-center gap-1 text-[11px] text-slate-400">
                    {s.output_mode === 'artifact' ? (
                      <>
                        <ArtifactIcon className="h-3.5 w-3.5" /> {s.artifact_type}
                      </>
                    ) : (
                      <>
                        <ChatIcon className="h-3.5 w-3.5" /> reply
                      </>
                    )}
                  </span>
                </div>
                <p className="mt-1 line-clamp-2 text-xs text-slate-500">
                  {s.description || s.instructions.slice(0, 120) || 'No description'}
                </p>
                <p className="mt-3 text-[11px] uppercase tracking-wide text-slate-400">
                  Updated {formatDate(s.updated_at)}
                </p>
              </button>
            ))}
          </div>
        )}
      </div>

      {editing && (
        <SkillEditor
          skill={editing}
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

function SkillEditor({
  skill,
  onClose,
  onSaved,
}: {
  skill: Skill
  onClose: () => void
  onSaved: () => void
}) {
  const [draft, setDraft] = useState(skill)
  const [saving, setSaving] = useState(false)

  async function save() {
    setSaving(true)
    await supabase
      .from('skills')
      .update({
        name: draft.name,
        description: draft.description,
        instructions: draft.instructions,
        output_mode: draft.output_mode,
        artifact_type: draft.artifact_type,
        updated_at: new Date().toISOString(),
      })
      .eq('id', draft.id)
    setSaving(false)
    onSaved()
  }

  async function remove() {
    if (!confirm(`Delete skill “${draft.name}”?`)) return
    await supabase.from('skills').delete().eq('id', draft.id)
    onSaved()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/40 p-0 sm:items-center sm:p-4">
      <div className="flex max-h-[92vh] w-full max-w-lg flex-col overflow-hidden rounded-t-2xl bg-white shadow-xl sm:rounded-2xl">
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3">
          <h2 className="text-sm font-semibold text-slate-700">Edit skill</h2>
          <button
            onClick={remove}
            className="rounded-md p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600"
            title="Delete"
          >
            <TrashIcon className="h-[18px] w-[18px]" />
          </button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto p-5">
          <Field label="Name">
            <input
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
            />
          </Field>
          <Field label="Description (optional)">
            <input
              value={draft.description ?? ''}
              onChange={(e) => setDraft({ ...draft, description: e.target.value })}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
            />
          </Field>
          <Field label="Instructions">
            <textarea
              value={draft.instructions}
              onChange={(e) => setDraft({ ...draft, instructions: e.target.value })}
              rows={9}
              placeholder="Tell the model exactly what to do with the conversation context…"
              className="w-full resize-y rounded-lg border border-slate-300 px-3 py-2 font-mono text-[13px] leading-relaxed outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
            />
          </Field>
          <div className="flex gap-3">
            <Field label="Output">
              <select
                value={draft.output_mode}
                onChange={(e) =>
                  setDraft({ ...draft, output_mode: e.target.value as SkillOutputMode })
                }
                className="w-full rounded-lg border border-slate-300 px-2 py-2 text-sm"
              >
                <option value="artifact">Create artifact</option>
                <option value="reply">Reply in chat</option>
              </select>
            </Field>
            {draft.output_mode === 'artifact' && (
              <Field label="Artifact type">
                <select
                  value={draft.artifact_type}
                  onChange={(e) =>
                    setDraft({ ...draft, artifact_type: e.target.value as ArtifactType })
                  }
                  className="w-full rounded-lg border border-slate-300 px-2 py-2 text-sm"
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
            disabled={saving || !draft.name.trim()}
            className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50"
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
      <span className="mb-1 block text-xs font-medium text-slate-600">{label}</span>
      {children}
    </label>
  )
}
