import { useCallback, useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import type { ArtifactType, Database, Json, Visibility } from '../lib/database.types'
import { standalonePageUrl, supabase } from '../lib/supabase'
import { makeSlug } from '../lib/util'
import { ArtifactFrame } from '../components/ArtifactFrame'
import { Markdown } from '../components/Markdown'
import { VisibilityControl } from '../components/VisibilityControl'
import { TrashIcon } from '../components/icons'

type Artifact = Database['public']['Tables']['artifacts']['Row']

const TYPES: ArtifactType[] = ['markdown', 'code', 'html', 'text']

export default function ArtifactEditorPage() {
  const { artifactId } = useParams()
  const navigate = useNavigate()
  const [artifact, setArtifact] = useState<Artifact | null>(null)
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [notFound, setNotFound] = useState(false)

  useEffect(() => {
    if (!artifactId) return
    supabase
      .from('artifacts')
      .select('*')
      .eq('id', artifactId)
      .single()
      .then(({ data }) => {
        if (data) setArtifact(data)
        else setNotFound(true)
      })
  }, [artifactId])

  const patch = useCallback((fields: Partial<Artifact>) => {
    setArtifact((a) => (a ? { ...a, ...fields } : a))
    setDirty(true)
  }, [])

  const save = useCallback(
    async (overrides?: Partial<Artifact>) => {
      if (!artifact) return
      const next = { ...artifact, ...overrides }
      setSaving(true)
      const { error } = await supabase
        .from('artifacts')
        .update({
          title: next.title,
          type: next.type,
          content: next.content,
          visibility: next.visibility,
          public_slug: next.public_slug,
          updated_at: new Date().toISOString(),
        })
        .eq('id', next.id)
      setSaving(false)
      if (!error) setDirty(false)
    },
    [artifact],
  )

  // Interactive-state saves from the preview iframe (checkboxes, notes, …).
  // Written directly — separate from the dirty/save cycle so clicking around
  // a live tracker never marks the *content* as unsaved.
  const saveData = useCallback(
    async (data: Json) => {
      if (!artifact) return
      setArtifact((a) => (a ? { ...a, data } : a))
      await supabase.from('artifacts').update({ data }).eq('id', artifact.id)
    },
    [artifact],
  )

  async function changeVisibility(visibility: Visibility) {
    if (!artifact) return
    // Public/unlisted artifacts need a slug for their share link.
    let slug = artifact.public_slug
    if (visibility !== 'private' && !slug) slug = makeSlug()
    const overrides = { visibility, public_slug: slug }
    patch(overrides)
    await save(overrides)
  }

  async function remove() {
    if (!artifact) return
    if (!confirm('Delete this artifact? This cannot be undone.')) return
    await supabase.from('artifacts').delete().eq('id', artifact.id)
    navigate('/artifacts')
  }

  if (notFound) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted">
        Artifact not found.
      </div>
    )
  }
  if (!artifact) {
    return <div className="flex h-full items-center justify-center text-sm text-faint">Loading…</div>
  }

  const shareUrl =
    artifact.public_slug ? `${window.location.origin}/share/a/${artifact.public_slug}` : null

  return (
    <div className="flex h-full flex-col overflow-y-auto md:flex-row md:overflow-hidden">
      {/* Editor */}
      <div className="flex min-w-0 flex-1 flex-col border-b border-border md:border-b-0 md:border-r">
        <div className="flex items-center gap-3 border-b border-border bg-surface px-4 py-3 md:px-5">
          <input
            value={artifact.title}
            onChange={(e) => patch({ title: e.target.value })}
            placeholder="Untitled"
            className="min-w-0 flex-1 bg-transparent text-lg font-semibold outline-none placeholder:text-faint"
          />
          <select
            value={artifact.type}
            onChange={(e) => patch({ type: e.target.value as ArtifactType })}
            className="rounded-md border border-border px-2 py-1 text-xs text-muted"
          >
            {TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <button
            onClick={() => save()}
            disabled={!dirty || saving}
            className="rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-white transition hover:bg-primary-strong disabled:opacity-50"
          >
            {saving ? 'Saving…' : dirty ? 'Save' : 'Saved'}
          </button>
          <button
            onClick={remove}
            title="Delete"
            className="rounded-lg p-1.5 text-faint hover:bg-red-50 hover:text-red-600"
          >
            <TrashIcon className="h-[18px] w-[18px]" />
          </button>
        </div>

        <textarea
          value={artifact.content}
          onChange={(e) => patch({ content: e.target.value })}
          spellCheck={false}
          className="min-h-[45vh] flex-1 resize-none bg-surface p-4 font-mono text-sm leading-relaxed text-text outline-none md:min-h-0 md:p-5"
          placeholder="Write here…"
        />
      </div>

      {/* Side panel: sharing + preview */}
      <div className="flex w-full flex-col bg-surface-2 md:w-96 md:overflow-y-auto">
        <div className="border-b border-border p-4">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">
            Sharing
          </h3>
          <VisibilityControl
            visibility={artifact.visibility}
            shareUrl={shareUrl}
            onChange={changeVisibility}
          />
          {artifact.type === 'html' && artifact.visibility !== 'private' && artifact.public_slug && (
            <a
              href={standalonePageUrl(artifact.public_slug)}
              target="_blank"
              rel="noreferrer"
              className="mt-2 flex items-center justify-center gap-1.5 rounded-lg border border-border bg-surface px-2 py-1.5 text-xs font-medium text-muted transition hover:border-primary hover:text-primary"
              title="Open the raw HTML as a clean standalone page — no intranet chrome"
            >
              Open as standalone page ↗
            </a>
          )}
        </div>
        <div className="p-4">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">
            Preview
          </h3>
          <div className="rounded-xl border border-border bg-surface p-4">
            {artifact.type === 'html' ? (
              <ArtifactFrame
                title="preview"
                content={artifact.content}
                data={artifact.data}
                onSave={saveData}
                className="h-80 w-full rounded border border-border"
              />
            ) : artifact.type === 'markdown' ? (
              <Markdown>{artifact.content || '_Nothing to preview_'}</Markdown>
            ) : (
              <pre className="overflow-x-auto whitespace-pre-wrap text-sm text-text">
                {artifact.content}
              </pre>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
