import { useCallback, useEffect, useState } from 'react'
import type { ArtifactType, Database, SkillOutputMode } from '../lib/database.types'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import { streamChat } from '../lib/chat'
import { formatDate } from '../lib/util'
import {
  parseSkillMarkdown,
  serializeSkillMarkdown,
  skillFilename,
} from '../lib/skillFormat'
import {
  ArtifactIcon,
  ChatIcon,
  DownloadIcon,
  PlusIcon,
  SparkleIcon,
  TrashIcon,
  UploadIcon,
} from '../components/icons'

type Skill = Database['public']['Tables']['skills']['Row']

const ARTIFACT_TYPES: ArtifactType[] = ['markdown', 'code', 'html', 'text']

/** Trigger a browser download of a skill in the portable SKILL.md format. */
function downloadSkill(skill: Pick<Skill, 'name' | 'description' | 'instructions'>) {
  const md = serializeSkillMarkdown({
    name: skill.name,
    description: skill.description ?? undefined,
    instructions: skill.instructions,
  })
  const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = skillFilename(skill.name)
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

export default function SkillsPage() {
  const { user } = useAuth()
  const [skills, setSkills] = useState<Skill[]>([])
  const [isAdmin, setIsAdmin] = useState(false)
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<Skill | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [uploadError, setUploadError] = useState<string | null>(null)

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

  async function handleFileUpload(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    if (!file) return

    setUploadError(null)

    // Validate file type
    if (!file.name.endsWith('.md') && !file.name.endsWith('.markdown')) {
      setUploadError('Please upload a Markdown (.md) file')
      event.target.value = ''
      return
    }

    try {
      const text = await file.text()
      const parsed = parseSkillMarkdown(text)

      // Validate required fields
      if (!parsed.name?.trim()) {
        setUploadError('Skill file must include a "name" in the frontmatter')
        event.target.value = ''
        return
      }

      if (!parsed.instructions?.trim()) {
        setUploadError('Skill file must include instructions')
        event.target.value = ''
        return
      }

      // Create the skill from the uploaded file
      const { data, error } = await supabase
        .from('skills')
        .insert({
          owner_id: user!.id,
          name: parsed.name,
          description: parsed.description || null,
          instructions: parsed.instructions,
          auto_apply: false, // Default to on-demand skill
          output_mode: 'artifact',
          artifact_type: 'markdown',
        })
        .select()
        .single()

      if (error) {
        setUploadError(error.message)
      } else if (data) {
        await load()
        setEditing(data)
      }
    } catch (e) {
      setUploadError(e instanceof Error ? e.message : 'Failed to upload skill')
    } finally {
      event.target.value = ''
    }
  }

  // Filter skills based on search query
  const filterSkills = (skillList: Skill[]) => {
    if (!searchQuery.trim()) return skillList
    const query = searchQuery.toLowerCase()
    return skillList.filter(
      (s) =>
        s.name.toLowerCase().includes(query) ||
        s.description?.toLowerCase().includes(query) ||
        s.instructions.toLowerCase().includes(query)
    )
  }

  const alwaysOn = filterSkills(skills.filter((s) => s.auto_apply))
  const onDemand = filterSkills(skills.filter((s) => !s.auto_apply))

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-4xl px-6 py-8">
        <div className="mb-6">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-2xl font-semibold tracking-tight text-text">Prompts &amp; skills</h1>
              <p className="mt-1 text-sm text-muted">
                Always-on prompts shape every chat. On-demand skills run when you type{' '}
                <code className="rounded bg-surface-2 px-1">/</code>.
              </p>
            </div>
            <div className="flex gap-2">
              <label
                htmlFor="skill-upload"
                className="flex cursor-pointer items-center gap-2 rounded-lg border border-border-strong px-4 py-2 text-sm font-semibold text-text transition hover:border-primary hover:text-primary"
              >
                <UploadIcon className="h-4 w-4" /> Upload .md
              </label>
              <input
                id="skill-upload"
                type="file"
                accept=".md,.markdown"
                onChange={handleFileUpload}
                className="hidden"
              />
              <button
                onClick={() => create(false)}
                className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white transition hover:bg-primary-strong"
              >
                <PlusIcon className="h-4 w-4" /> New skill
              </button>
            </div>
          </div>
          <div className="mt-4">
            <input
              type="text"
              placeholder="Search skills by name or description..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full rounded-lg border border-border-strong bg-surface px-4 py-2.5 text-sm outline-none placeholder:text-faint focus:border-primary focus:ring-2 focus:ring-primary-soft"
            />
          </div>
          {uploadError && (
            <div className="mt-3 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">
              <div className="flex items-center justify-between">
                <span>{uploadError}</span>
                <button
                  onClick={() => setUploadError(null)}
                  className="ml-2 text-red-500 hover:text-red-700"
                >
                  ×
                </button>
              </div>
            </div>
          )}
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
                  {searchQuery.trim()
                    ? 'No always-on prompts match your search.'
                    : 'No always-on prompts yet.'}
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
                  {searchQuery.trim()
                    ? 'No on-demand skills match your search.'
                    : 'No skills yet. Create one to run it from chat.'}
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
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onClick()
        }
      }}
      className="group cursor-pointer rounded-xl border border-border bg-surface p-4 text-left transition hover:border-brand-300 hover:shadow-sm"
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="truncate font-medium text-text group-hover:text-primary">
          {skill.name}
        </h3>
        <div className="flex shrink-0 items-center gap-2">
          {skill.is_builtin ? (
            <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted">
              Built-in
            </span>
          ) : alwaysOn ? null : (
            <span className="flex items-center gap-1 text-[11px] text-faint">
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
          <button
            onClick={(e) => {
              e.stopPropagation()
              downloadSkill(skill)
            }}
            title="Download as SKILL.md"
            className="rounded-md p-1 text-faint opacity-0 transition hover:bg-surface-hover hover:text-primary focus:opacity-100 group-hover:opacity-100"
          >
            <DownloadIcon className="h-4 w-4" />
          </button>
        </div>
      </div>
      <p className="mt-1 line-clamp-2 text-xs text-muted">
        {skill.description || skill.instructions.slice(0, 120) || 'No description'}
      </p>
      <p className="mt-3 text-[11px] uppercase tracking-wide text-faint">
        Updated {formatDate(skill.updated_at)}
      </p>
    </div>
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
  const [polishing, setPolishing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Ask the assistant to clean up and flesh out the skill, then fold its
  // rewritten name/description/instructions back into the draft (unsaved until
  // the user hits Save).
  async function polish() {
    setPolishing(true)
    setError(null)
    try {
      const current = serializeSkillMarkdown({
        name: draft.name,
        description: draft.description ?? undefined,
        instructions: draft.instructions,
      })
      const system = draft.auto_apply
        ? 'You are helping an operator author an always-on prompt that shapes every AI chat in a workspace. Rewrite the draft below so it is clear, specific, and well-structured WITHOUT changing its intent. Give it a short human name, a one-sentence description, and flesh out the prompt itself.'
        : 'You are helping an operator author a reusable "skill" — a saved instruction set an AI assistant runs on demand. Rewrite the draft below so it is clear, specific, and well-structured WITHOUT changing its intent. Give it a short human name, a one-sentence description of when to use it, and flesh out the instructions with concrete steps, tone, and any output-format expectations.'
      const full = await streamChat(
        [{ role: 'user', content: `Here is the current draft:\n\n${current}` }],
        () => {},
        {
          replaceSystem: true,
          system: `${system}\n\nReturn ONLY a Markdown skill file and nothing else: a YAML frontmatter block with "name" and "description" keys delimited by lines of ---, followed by the instructions as the body. Do not wrap the whole thing in code fences.`,
        },
      )
      const parsed = parseSkillMarkdown(full)
      setDraft((d) => ({
        ...d,
        name: parsed.name?.trim() || d.name,
        description: parsed.description ?? d.description,
        instructions: parsed.instructions || d.instructions,
      }))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not polish the skill.')
    } finally {
      setPolishing(false)
    }
  }

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

          <div className="flex flex-wrap gap-2">
            {canEdit && (
              <button
                onClick={polish}
                disabled={polishing}
                title="Let AI clean up and flesh out this skill"
                className="flex items-center gap-1.5 rounded-lg border border-border-strong px-3 py-1.5 text-sm font-medium text-text transition hover:border-primary hover:text-primary disabled:opacity-50"
              >
                <SparkleIcon className="h-4 w-4" />
                {polishing ? 'Polishing…' : 'Polish with AI'}
              </button>
            )}
            <button
              onClick={() => downloadSkill(draft)}
              title="Download as SKILL.md"
              className="flex items-center gap-1.5 rounded-lg border border-border-strong px-3 py-1.5 text-sm font-medium text-text transition hover:border-primary hover:text-primary"
            >
              <DownloadIcon className="h-4 w-4" />
              Download .md
            </button>
          </div>

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
