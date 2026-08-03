import { forwardRef, useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import type { ArtifactType, Database, Json, Visibility } from '../lib/database.types'
import { standalonePageUrl, supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import { imageMarkdown, insertAtCursor, isImageFile, isUrl, sanitizeImageName, urlToMarkdown } from '../lib/artifactImages'
import { uploadPickedFile } from '../lib/upload'
import { makeSlug } from '../lib/util'
import { ArtifactFrame } from '../components/ArtifactFrame'
import { Markdown } from '../components/Markdown'
import { ResizeHandle, usePanelResize } from '../components/ResizeHandle'
import { VisibilityControl } from '../components/VisibilityControl'
import { CollectionSelector } from '../components/CollectionSelector'
import { CopyButton } from '../components/CopyButton'
import { ChatIcon, PaperclipIcon, PinIcon, TrashIcon } from '../components/icons'

type Artifact = Database['public']['Tables']['artifacts']['Row']

const TYPES: ArtifactType[] = ['markdown', 'code', 'html', 'text']
const IMAGE_BUCKET = 'artifact-images'

export default function ArtifactEditorPage() {
  const { artifactId } = useParams()
  const navigate = useNavigate()
  const { user } = useAuth()
  const [artifact, setArtifact] = useState<Artifact | null>(null)
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [notFound, setNotFound] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const imageInputRef = useRef<HTMLInputElement>(null)
  const panelResize = usePanelResize('artifact-editor-panel-w', 384)
  const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [showFilePicker, setShowFilePicker] = useState(false)
  const [filePickerSearch, setFilePickerSearch] = useState('')
  const [slashCommandStart, setSlashCommandStart] = useState<number | null>(null)
  const [availableFiles, setAvailableFiles] = useState<Array<{ id: string; name: string; title: string | null }>>([])
  const filePickerRef = useRef<HTMLDivElement>(null)

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

  // Load available files for the file picker
  useEffect(() => {
    supabase
      .from('files')
      .select('id, name, title')
      .order('created_at', { ascending: false })
      .limit(100)
      .then(({ data }) => {
        if (data) setAvailableFiles(data)
      })
  }, [])

  const patch = useCallback((fields: Partial<Artifact>) => {
    setArtifact((a) => (a ? { ...a, ...fields } : a))
    setDirty(true)
  }, [])

  // GitHub-style image drop/paste: upload each image to the public
  // `artifact-images` bucket (a stable, non-expiring URL that keeps working
  // when the artifact is shared publicly) and splice a markdown `![](url)`
  // link into the body at the caret. Non-image files are ignored.
  const insertImages = useCallback(
    async (files: File[]) => {
      if (!user || !artifact) return
      const images = files.filter(isImageFile)
      if (images.length === 0) return
      setUploading(true)
      setUploadError(null)
      try {
        const urls: string[] = []
        for (const file of images) {
          const name = sanitizeImageName(file.name, file.type)
          const path = `${user.id}/${crypto.randomUUID()}/${name}`
          await uploadPickedFile(path, file, IMAGE_BUCKET, { artifact_id: artifact.id })
          const { data, error } = await supabase.storage
            .from(IMAGE_BUCKET)
            .createSignedUrl(path, 60 * 60 * 24 * 7)
          if (error) throw error
          urls.push(data.signedUrl)
        }
        const block = urls.map((u) => imageMarkdown(u)).join('\n')
        const el = textareaRef.current
        const current = artifact?.content ?? ''
        const start = el ? el.selectionStart : current.length
        const end = el ? el.selectionEnd : current.length
        const { text, cursor } = insertAtCursor(current, start, end, block)
        patch({ content: text })
        // Restore the caret just after the inserted markdown once React repaints.
        requestAnimationFrame(() => {
          const node = textareaRef.current
          if (node) {
            node.focus()
            node.setSelectionRange(cursor, cursor)
          }
        })
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Image upload failed'
        setUploadError(
          /failed to fetch|networkerror|load failed/i.test(msg)
            ? 'Couldn’t upload that image — the request didn’t reach the server. Try again.'
            : msg,
        )
      } finally {
        setUploading(false)
      }
    },
    [artifact, patch, user],
  )

  const handlePaste = useCallback(
    (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const files = Array.from(e.clipboardData?.files ?? [])
      if (files.some(isImageFile)) {
        e.preventDefault() // don't paste the OS file path / blob text too
        void insertImages(files)
        return
      }
      // URL detection: if the pasted text is a URL, convert it to a markdown link.
      const text = e.clipboardData?.getData('text/plain')
      if (text && isUrl(text)) {
        e.preventDefault()
        const el = textareaRef.current
        const current = artifact?.content ?? ''
        const start = el ? el.selectionStart : current.length
        const end = el ? el.selectionEnd : current.length
        const markdown = urlToMarkdown(text)
        const { text: newText, cursor } = insertAtCursor(current, start, end, markdown)
        patch({ content: newText })
        // Restore the caret just after the inserted markdown once React repaints.
        requestAnimationFrame(() => {
          const node = textareaRef.current
          if (node) {
            node.focus()
            node.setSelectionRange(cursor, cursor)
          }
        })
      }
    },
    [insertImages, artifact, patch],
  )

  const handleDrop = useCallback(
    (e: React.DragEvent<HTMLTextAreaElement>) => {
      const files = Array.from(e.dataTransfer?.files ?? [])
      if (files.some(isImageFile)) {
        e.preventDefault()
        void insertImages(files)
      }
    },
    [insertImages],
  )

  const handleContentChange = useCallback(
    (newContent: string) => {
      patch({ content: newContent })

      // Detect /LinkFile command
      const el = textareaRef.current
      if (!el) return

      const cursorPos = el.selectionStart
      const textBeforeCursor = newContent.substring(0, cursorPos)

      // Look for /LinkFile or just / followed by text
      const lastSlashIndex = textBeforeCursor.lastIndexOf('/')
      if (lastSlashIndex !== -1) {
        const textAfterSlash = textBeforeCursor.substring(lastSlashIndex + 1)
        const wordBoundaryBefore = lastSlashIndex === 0 || /\s/.test(textBeforeCursor[lastSlashIndex - 1])

        if (wordBoundaryBefore && !textAfterSlash.includes('\n')) {
          // Show file picker
          setSlashCommandStart(lastSlashIndex)
          setFilePickerSearch(textAfterSlash.toLowerCase())
          setShowFilePicker(true)
        } else {
          setShowFilePicker(false)
        }
      } else {
        setShowFilePicker(false)
      }
    },
    [patch],
  )

  const insertFileLink = useCallback(
    async (file: { id: string; name: string; title: string | null }) => {
      if (!artifact || slashCommandStart === null) return

      const el = textareaRef.current
      if (!el) return

      // Get a signed URL for the file
      const { data: fileData } = await supabase
        .from('files')
        .select('*')
        .eq('id', file.id)
        .single()

      if (!fileData) return

      const { data: signedData } = await supabase.storage
        .from(fileData.bucket)
        .createSignedUrl(fileData.path, 60 * 60 * 24 * 7) // 7 days

      if (!signedData?.signedUrl) return

      const linkText = file.title || file.name
      const markdownLink = `[${linkText}](${signedData.signedUrl})`

      const content = artifact.content
      const cursorPos = el.selectionStart

      // Replace from slash command start to cursor
      const before = content.substring(0, slashCommandStart)
      const after = content.substring(cursorPos)
      const newContent = before + markdownLink + after

      patch({ content: newContent })
      setShowFilePicker(false)
      setSlashCommandStart(null)

      // Restore cursor position
      requestAnimationFrame(() => {
        if (textareaRef.current) {
          const newCursorPos = slashCommandStart + markdownLink.length
          textareaRef.current.focus()
          textareaRef.current.setSelectionRange(newCursorPos, newCursorPos)
        }
      })
    },
    [artifact, slashCommandStart, patch],
  )

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
    // Public/unlisted artifacts need a slug for their external share link.
    // Workspace artifacts are internal-only and don't need a public slug.
    let slug = artifact.public_slug
    if ((visibility === 'unlisted' || visibility === 'public') && !slug) slug = makeSlug()
    const overrides = { visibility, public_slug: slug }
    patch(overrides)
    await save(overrides)
  }

  async function setSharePassword(password: string) {
    if (!artifact) return
    const { error } = await supabase.rpc('set_artifact_password', {
      p_id: artifact.id,
      p_password: password,
    })
    if (error) throw error
    // We don't get the hash back; a non-null placeholder flags "protected".
    setArtifact((a) => (a ? { ...a, share_password_hash: 'set' } : a))
  }

  async function removeSharePassword() {
    if (!artifact) return
    const { error } = await supabase.rpc('set_artifact_password', {
      p_id: artifact.id,
      p_password: null,
    })
    if (error) throw error
    setArtifact((a) => (a ? { ...a, share_password_hash: null } : a))
  }

  async function remove() {
    if (!artifact) return
    // Soft delete: archive to Trash (recoverable from the Artifacts page) rather
    // than destroy. Permanent deletion happens from the Trash panel there.
    if (!confirm('Archive this artifact? It moves to Trash and can be restored later.')) return
    await supabase.from('artifacts').update({ deleted_at: new Date().toISOString() }).eq('id', artifact.id)
    navigate('/artifacts')
  }

  // Cmd+S / Ctrl+S to save
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault()
        void save()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [save])

  // Auto-save when dirty (debounced)
  useEffect(() => {
    if (!dirty) return
    // Clear any pending timer
    if (autoSaveTimerRef.current) {
      clearTimeout(autoSaveTimerRef.current)
    }
    // Set new timer for 2 seconds
    autoSaveTimerRef.current = setTimeout(() => {
      void save()
    }, 2000)
    return () => {
      if (autoSaveTimerRef.current) {
        clearTimeout(autoSaveTimerRef.current)
      }
    }
  }, [dirty, save])

  // Save before unmount or navigation
  useEffect(() => {
    return () => {
      // Save on unmount if dirty
      if (dirty && artifact) {
        void supabase
          .from('artifacts')
          .update({
            title: artifact.title,
            type: artifact.type,
            content: artifact.content,
            visibility: artifact.visibility,
            public_slug: artifact.public_slug,
            updated_at: new Date().toISOString(),
          })
          .eq('id', artifact.id)
      }
    }
  }, [dirty, artifact])

  // Save before page unload (browser close/refresh)
  useEffect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (dirty) {
        void save()
        // Browser will show its own confirmation dialog
        e.preventDefault()
        e.returnValue = ''
      }
    }
    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => window.removeEventListener('beforeunload', handleBeforeUnload)
  }, [dirty, save])

  // Close file picker when clicking outside
  useEffect(() => {
    if (!showFilePicker) return
    const handleClickOutside = (e: MouseEvent) => {
      if (filePickerRef.current && !filePickerRef.current.contains(e.target as Node)) {
        setShowFilePicker(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [showFilePicker])

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

  // Only unlisted/public artifacts get an external share URL. Workspace artifacts
  // are internal-only and don't need a public slug or share link.
  const shareUrl =
    artifact.public_slug && (artifact.visibility === 'unlisted' || artifact.visibility === 'public')
      ? `${window.location.origin}/share/a/${artifact.public_slug}`
      : null

  return (
    <div className="flex h-full flex-col overflow-y-auto md:flex-row md:overflow-hidden">
      {/* Editor */}
      <div className="flex min-w-0 flex-1 flex-col border-b border-border md:border-b-0 md:border-r">
        {/* Header. On mobile the title takes its own full-width row and the
            controls wrap below it — otherwise the buttons squeeze the title
            input to zero width and there's nowhere to type a name (issue #117).
            md+ keeps the classic single row. */}
        <div className="flex flex-col gap-3 border-b border-border bg-surface px-4 py-3 md:flex-row md:items-center md:px-5">
          <input
            value={artifact.title}
            onChange={(e) => patch({ title: e.target.value })}
            placeholder="Untitled"
            aria-label="Artifact title"
            className="w-full min-w-0 bg-transparent text-lg font-semibold outline-none placeholder:text-faint md:flex-1"
          />
          <div className="flex flex-wrap items-center gap-2 md:gap-3">
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
              onClick={() => imageInputRef.current?.click()}
              disabled={uploading}
              title="Attach an image — it uploads and is inserted as markdown. You can also paste or drag one into the editor."
              className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-muted transition hover:border-primary hover:text-primary disabled:opacity-50"
            >
              <PaperclipIcon className="h-4 w-4" /> {uploading ? 'Uploading…' : 'Image'}
            </button>
            <input
              ref={imageInputRef}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={(e) => {
                void insertImages(Array.from(e.target.files ?? []))
                e.target.value = ''
              }}
            />
            <CopyButton
              text={artifact.content}
              label="Copy"
              title="Copy the artifact content"
              iconClassName="h-4 w-4"
              className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-muted transition hover:border-primary hover:text-primary"
            />
            <CopyButton
              text={artifact.id}
              label="Copy ID"
              title="Copy the artifact ID (for use with MCP tools)"
              iconClassName="h-4 w-4"
              className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-muted transition hover:border-primary hover:text-primary"
            />
            <button
              onClick={() => navigate(`/chat?artifact=${artifact.id}`)}
              title="Chat with the assistant about this artifact — it opens live beside the thread"
              className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-muted transition hover:border-primary hover:text-primary"
            >
              <ChatIcon className="h-4 w-4" /> Chat
            </button>
            <button
              onClick={() => save()}
              disabled={!dirty || saving}
              className="ml-auto rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-white transition hover:bg-primary-strong disabled:opacity-50 md:ml-0"
            >
              {saving ? 'Saving…' : dirty ? 'Save' : 'Saved'}
            </button>
            <button
              onClick={async () => {
                await supabase
                  .from('artifacts')
                  .update({ pinned: !artifact.pinned })
                  .eq('id', artifact.id)
                patch({ pinned: !artifact.pinned })
              }}
              title={artifact.pinned ? 'Unpin from Home' : 'Pin to Home'}
              className={`rounded-lg p-1.5 transition ${
                artifact.pinned
                  ? 'text-primary hover:bg-primary-soft'
                  : 'text-faint hover:bg-surface-hover'
              }`}
            >
              <PinIcon className="h-[18px] w-[18px]" />
            </button>
            <button
              onClick={remove}
              title="Archive"
              className="rounded-lg p-1.5 text-faint hover:bg-red-50 hover:text-red-600"
            >
              <TrashIcon className="h-[18px] w-[18px]" />
            </button>
          </div>
        </div>

        <div className="relative flex-1">
          <textarea
            ref={textareaRef}
            value={artifact.content}
            onChange={(e) => handleContentChange(e.target.value)}
            onPaste={handlePaste}
            onDrop={handleDrop}
            onKeyDown={(e) => {
              if (showFilePicker && (e.key === 'Escape' || e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter')) {
                if (e.key === 'Escape') {
                  e.preventDefault()
                  setShowFilePicker(false)
                }
              }
            }}
            spellCheck={false}
            className="min-h-[45vh] h-full w-full resize-none bg-surface p-4 font-mono text-sm leading-relaxed text-text outline-none md:min-h-0 md:p-5"
            placeholder="Write here…  (paste or drop an image to embed it; paste a URL to make it a link; type /LinkFile to insert a file link)"
          />
          {showFilePicker && (
            <FilePicker
              ref={filePickerRef}
              files={availableFiles.filter(f =>
                (f.title || f.name).toLowerCase().includes(filePickerSearch)
              )}
              onSelect={insertFileLink}
              onClose={() => setShowFilePicker(false)}
            />
          )}
        </div>
        {uploadError && (
          <div className="border-t border-border bg-red-50 px-4 py-2 text-xs text-red-600 md:px-5">
            {uploadError}
          </div>
        )}
      </div>

      {/* Side panel: sharing + preview — drag its left edge to widen (md+) */}
      <div
        style={panelResize.panelStyle}
        className="relative flex w-full flex-col bg-surface-2 md:w-[var(--panel-w)] md:shrink-0 md:overflow-y-auto"
      >
        <ResizeHandle onPointerDown={panelResize.onPointerDown} />
        <div className="border-b border-border p-4">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">
            Sharing
          </h3>
          <VisibilityControl
            visibility={artifact.visibility}
            shareUrl={shareUrl}
            onChange={changeVisibility}
            password={{
              protectedWithPassword: !!artifact.share_password_hash,
              onSave: setSharePassword,
              onRemove: removeSharePassword,
            }}
          />
          {artifact.type === 'html' &&
            (artifact.visibility === 'unlisted' || artifact.visibility === 'public') &&
            artifact.public_slug && (
            <a
              href={standalonePageUrl(artifact.public_slug)}
              target="_blank"
              rel="noreferrer"
              className="mt-2 flex items-center justify-center gap-1.5 rounded-lg border border-border bg-surface px-2 py-1.5 text-xs font-medium text-muted transition hover:border-primary hover:text-primary"
              title="Open as a clean, full-screen standalone page — no intranet chrome"
            >
              Open as standalone page ↗
            </a>
          )}
        </div>
        <div className="border-b border-border p-4">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">
            Collections
          </h3>
          <CollectionSelector itemId={artifact.id} itemType="artifact" />
        </div>
        <div
          className={
            // HTML previews fill the rest of the panel; text previews keep
            // their natural height and let the panel scroll.
            artifact.type === 'html' ? 'flex min-h-0 flex-1 flex-col p-4' : 'p-4'
          }
        >
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">
            Preview
          </h3>
          <div
            className={
              artifact.type === 'html'
                ? 'flex min-h-0 flex-1 flex-col rounded-xl border border-border bg-surface p-2'
                : 'rounded-xl border border-border bg-surface p-4'
            }
          >
            {artifact.type === 'html' ? (
              <ArtifactFrame
                title="preview"
                content={artifact.content}
                data={artifact.data}
                onSave={saveData}
                // Mobile stacks and scrolls, so a viewport height; md+ fills the panel.
                className="h-[70vh] w-full rounded border border-border md:h-auto md:min-h-0 md:flex-1"
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

const FilePicker = forwardRef<
  HTMLDivElement,
  {
    files: Array<{ id: string; name: string; title: string | null }>
    onSelect: (file: { id: string; name: string; title: string | null }) => void
    onClose: () => void
  }
>(({ files, onSelect, onClose }, ref) => {
  const [selectedIndex, setSelectedIndex] = useState(0)

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSelectedIndex((prev) => Math.min(prev + 1, files.length - 1))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSelectedIndex((prev) => Math.max(prev - 1, 0))
      } else if (e.key === 'Enter') {
        e.preventDefault()
        if (files[selectedIndex]) {
          onSelect(files[selectedIndex])
        }
      } else if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [files, selectedIndex, onSelect, onClose])

  if (files.length === 0) {
    return (
      <div
        ref={ref}
        className="absolute left-4 top-full z-50 mt-1 w-80 rounded-lg border border-border bg-surface p-3 text-sm text-muted shadow-xl"
      >
        No files found. Try a different search.
      </div>
    )
  }

  return (
    <div
      ref={ref}
      className="absolute left-4 top-full z-50 mt-1 w-80 max-h-64 overflow-y-auto rounded-lg border border-border bg-surface shadow-xl"
    >
      <div className="p-2 text-xs font-medium text-muted border-b border-border">
        Link to file (↑↓ to navigate, ⏎ to select, esc to cancel)
      </div>
      {files.slice(0, 10).map((file, index) => (
        <button
          key={file.id}
          onClick={() => onSelect(file)}
          className={`w-full px-3 py-2 text-left text-sm transition ${
            index === selectedIndex
              ? 'bg-primary-soft text-primary'
              : 'text-text hover:bg-surface-hover'
          }`}
        >
          <div className="font-medium truncate">{file.title || file.name}</div>
          {file.title && (
            <div className="text-xs text-faint truncate">{file.name}</div>
          )}
        </button>
      ))}
      {files.length > 10 && (
        <div className="p-2 text-xs text-faint border-t border-border">
          {files.length - 10} more files... (keep typing to narrow)
        </div>
      )}
    </div>
  )
})

FilePicker.displayName = 'FilePicker'
