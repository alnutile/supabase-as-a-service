import { useCallback, useEffect, useRef, useState } from 'react'
import type { Database } from '../lib/database.types'
import { publicFileUrl, supabase } from '../lib/supabase'
import { uploadPickedFile } from '../lib/upload'
import { useAuth } from '../contexts/AuthContext'
import { formatBytes, formatDate } from '../lib/util'
import { CheckIcon, FileIcon, LinkIcon, TrashIcon, UploadIcon, GridIcon, ListIcon, DownloadIcon, PencilIcon, GlobeIcon, CopyIcon, CloseIcon } from '../components/icons'
import { AddToCollectionBar } from '../components/AddToCollectionBar'
import {
  PUBLIC_FILES_BUCKET,
  SHARE_MODES,
  shareExpirySeconds,
  shareModeLabel,
  shareValidityNote,
  type ShareMode,
} from '../lib/fileShare'

type ShareResult = { mode: ShareMode; items: { name: string; url: string }[] }

type FileRow = Database['public']['Tables']['files']['Row']
type Doc = Database['public']['Tables']['documents']['Row']
const BUCKET = 'files'
type ViewMode = 'list' | 'grid'

export default function FilesPage() {
  const { user } = useAuth()
  const [files, setFiles] = useState<FileRow[]>([])
  const [loading, setLoading] = useState(true)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [linkFor, setLinkFor] = useState<{ id: string; url: string } | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [shareResult, setShareResult] = useState<ShareResult | null>(null)
  const [shareBusy, setShareBusy] = useState<ShareMode | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    const saved = localStorage.getItem('files-view-mode')
    return (saved === 'grid' || saved === 'list') ? saved : 'list'
  })
  const [thumbnails, setThumbnails] = useState<Record<string, string>>({})

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function changeViewMode(mode: ViewMode) {
    setViewMode(mode)
    localStorage.setItem('files-view-mode', mode)
  }

  const [docs, setDocs] = useState<Record<string, Doc>>({})

  const load = useCallback(async () => {
    const { data } = await supabase
      .from('files')
      .select('*')
      .order('created_at', { ascending: false })
    setFiles(data ?? [])
    setLoading(false)

    // Load thumbnails for image files
    const imageFiles = (data ?? []).filter(f => f.mime_type?.startsWith('image/'))
    if (imageFiles.length > 0) {
      const { data: signed } = await supabase.storage
        .from(BUCKET)
        .createSignedUrls(imageFiles.map(f => f.path), 3600)
      const thumbs: Record<string, string> = {}
      imageFiles.forEach((f, i) => {
        const s = signed?.[i]
        if (s?.signedUrl) thumbs[f.id] = s.signedUrl
      })
      setThumbnails(thumbs)
    }
  }, [])

  const loadDocs = useCallback(async () => {
    const { data } = await supabase.from('documents').select('*')
    const map: Record<string, Doc> = {}
    // Notes pushed via MCP have no backing file (file_id null); they aren't
    // shown in Files, so only index file-backed documents here.
    for (const d of data ?? []) if (d.file_id) map[d.file_id] = d
    setDocs(map)
  }, [])

  useEffect(() => {
    load()
    loadDocs()
    // Live-update indexing status as the ingest worker progresses.
    const channel = supabase
      .channel('documents')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'documents' }, () => loadDocs())
      .subscribe()
    return () => {
      supabase.removeChannel(channel)
    }
  }, [load, loadDocs])

  // Share an indexed document with the workspace, or keep it private. (Separate
  // from files.visibility, which controls signed-link sharing of the raw blob.)
  async function setScope(doc: Doc, scope: string) {
    if (doc.file_id) setDocs((prev) => ({ ...prev, [doc.file_id!]: { ...doc, scope } }))
    await supabase.from('documents').update({ scope }).eq('id', doc.id)
  }

  async function handleUpload(fileList: FileList | null) {
    if (!fileList || fileList.length === 0) return
    setUploading(true)
    setError(null)
    try {
      for (const file of Array.from(fileList)) {
        const path = `${user!.id}/${crypto.randomUUID()}/${file.name}`
        const size = await uploadPickedFile(path, file)
        const { error: rowErr } = await supabase.from('files').insert({
          owner_id: user!.id,
          bucket: BUCKET,
          path,
          name: file.name,
          mime_type: file.type || null,
          size_bytes: size,
          visibility: 'private',
        })
        if (rowErr) throw rowErr
      }
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed')
    } finally {
      setUploading(false)
      if (inputRef.current) inputRef.current.value = ''
    }
  }

  async function download(f: FileRow) {
    const { data, error: err } = await supabase.storage
      .from(f.bucket)
      .createSignedUrl(f.path, 60)
    if (err || !data) {
      setError(err?.message ?? 'Could not create download link')
      return
    }
    window.open(data.signedUrl, '_blank')
  }

  async function share(f: FileRow) {
    // A 7-day signed link — a capability URL anyone can use until it expires.
    const { data, error: err } = await supabase.storage
      .from(f.bucket)
      .createSignedUrl(f.path, 60 * 60 * 24 * 7)
    if (err || !data) {
      setError(err?.message ?? 'Could not create share link')
      return
    }
    await supabase.from('files').update({ visibility: 'unlisted' }).eq('id', f.id)
    await navigator.clipboard.writeText(data.signedUrl).catch(() => {})
    setLinkFor({ id: f.id, url: data.signedUrl })
    load()
  }

  function flashToast(msg: string) {
    setToast(msg)
    window.setTimeout(() => setToast(null), 2500)
  }

  async function copyText(text: string) {
    await navigator.clipboard.writeText(text).catch(() => {})
    flashToast('Copied to clipboard')
  }

  // Publish a file to the public bucket: copy the bytes over (private bucket
  // objects can't be served publicly), then flag the row. Returns the stable
  // public URL. Idempotent — re-publishing just upserts and re-derives the URL.
  async function publishFile(f: FileRow): Promise<string> {
    if (!f.public_path) {
      const { data: blob, error: dlErr } = await supabase.storage.from(f.bucket).download(f.path)
      if (dlErr || !blob) throw dlErr ?? new Error('Could not read the file')
      const { error: upErr } = await supabase.storage
        .from(PUBLIC_FILES_BUCKET)
        .upload(f.path, blob, { upsert: true, contentType: f.mime_type || undefined })
      if (upErr) throw upErr
      await supabase.from('files').update({ visibility: 'public', public_path: f.path }).eq('id', f.id)
      setFiles((prev) =>
        prev.map((x) => (x.id === f.id ? { ...x, visibility: 'public', public_path: f.path } : x)),
      )
    }
    return publicFileUrl(f.public_path ?? f.path)
  }

  // Unpublish: drop the public copy and revert the row to private. The private
  // original in the `files` bucket is untouched.
  async function unpublishFile(f: FileRow) {
    if (f.public_path) {
      await supabase.storage.from(PUBLIC_FILES_BUCKET).remove([f.public_path])
    }
    await supabase.from('files').update({ visibility: 'private', public_path: null }).eq('id', f.id)
    setFiles((prev) =>
      prev.map((x) => (x.id === f.id ? { ...x, visibility: 'private', public_path: null } : x)),
    )
  }

  // Share every selected file at once in the chosen mode. 'public' publishes for
  // a permanent URL; the timed modes mint signed URLs of the matching window.
  async function bulkShare(mode: ShareMode) {
    const chosen = files.filter((f) => selected.has(f.id))
    if (!chosen.length || shareBusy) return
    setShareBusy(mode)
    setError(null)
    try {
      const items: { name: string; url: string }[] = []
      if (mode === 'public') {
        for (const f of chosen) {
          try {
            items.push({ name: f.title || f.name, url: await publishFile(f) })
          } catch (err) {
            setError(err instanceof Error ? err.message : `Could not publish "${f.name}"`)
          }
        }
      } else {
        const expiry = shareExpirySeconds(mode)!
        const { data, error: err } = await supabase.storage
          .from(BUCKET)
          .createSignedUrls(
            chosen.map((f) => f.path),
            expiry,
          )
        if (err || !data) throw err ?? new Error('Could not create share links')
        data.forEach((row, i) => {
          if (row.signedUrl) items.push({ name: chosen[i].title || chosen[i].name, url: row.signedUrl })
        })
        // Signed sharing flips still-private files to 'unlisted' (the "link
        // shared" label); published files keep their 'public' state.
        const toMark = chosen.filter((f) => f.visibility === 'private').map((f) => f.id)
        if (toMark.length) {
          await supabase.from('files').update({ visibility: 'unlisted' }).in('id', toMark)
          setFiles((prev) =>
            prev.map((x) => (toMark.includes(x.id) ? { ...x, visibility: 'unlisted' } : x)),
          )
        }
      }
      if (items.length) {
        setShareResult({ mode, items })
        if (items.length === 1) await copyText(items[0].url)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create share links')
    } finally {
      setShareBusy(null)
    }
  }

  async function remove(f: FileRow) {
    if (!confirm(`Delete "${f.name}"?`)) return
    await supabase.storage.from(f.bucket).remove([f.path])
    if (f.public_path) await supabase.storage.from(PUBLIC_FILES_BUCKET).remove([f.public_path])
    await supabase.from('files').delete().eq('id', f.id)
    load()
  }

  async function updateFileMetadata(id: string, title: string | null, description: string | null) {
    await supabase
      .from('files')
      .update({ title, description })
      .eq('id', id)
    load()
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-4xl px-6 py-8">
        <div className="mb-6">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-2xl font-semibold tracking-tight text-text">Files</h1>
              <p className="mt-1 text-sm text-muted">
                Private by default. Select files to share in bulk — a permanent public link or a
                signed link (1 hour / 1 day / 1 week) — or add them to a collection to chat with.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <div className="flex items-center gap-1 rounded-lg border border-border bg-surface p-1">
                <button
                  onClick={() => changeViewMode('list')}
                  title="List view"
                  className={`rounded-md p-1.5 transition ${
                    viewMode === 'list'
                      ? 'bg-primary text-white'
                      : 'text-faint hover:bg-surface-hover hover:text-muted'
                  }`}
                >
                  <ListIcon className="h-4 w-4" />
                </button>
                <button
                  onClick={() => changeViewMode('grid')}
                  title="Grid view"
                  className={`rounded-md p-1.5 transition ${
                    viewMode === 'grid'
                      ? 'bg-primary text-white'
                      : 'text-faint hover:bg-surface-hover hover:text-muted'
                  }`}
                >
                  <GridIcon className="h-4 w-4" />
                </button>
              </div>
              <button
                onClick={() => inputRef.current?.click()}
                disabled={uploading}
                className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white transition hover:bg-primary-strong disabled:opacity-60"
              >
                <UploadIcon className="h-4 w-4" /> {uploading ? 'Uploading…' : 'Upload'}
              </button>
            </div>
          </div>
          <input
            ref={inputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => handleUpload(e.target.files)}
          />
        </div>

        {error && (
          <p className="mb-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>
        )}

        {selected.size > 0 && (
          <div className="mb-4 flex flex-wrap items-center gap-2 rounded-xl border border-border bg-surface px-3 py-2.5">
            <span className="text-sm font-medium text-text">{selected.size} selected</span>
            <span className="text-sm text-muted">Share:</span>
            {SHARE_MODES.map((mode) => (
              <button
                key={mode}
                onClick={() => bulkShare(mode)}
                disabled={shareBusy !== null}
                title={shareValidityNote(mode)}
                className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm font-semibold transition disabled:opacity-50 ${
                  mode === 'public'
                    ? 'border-primary bg-primary text-white hover:bg-primary-strong'
                    : 'border-border-strong text-text hover:bg-surface-hover'
                }`}
              >
                {mode === 'public' && <GlobeIcon className="h-4 w-4" />}
                {shareBusy === mode ? 'Sharing…' : shareModeLabel(mode)}
              </button>
            ))}
            <button
              onClick={() => setSelected(new Set())}
              className="ml-auto text-sm font-medium text-muted hover:text-text"
            >
              Clear
            </button>
          </div>
        )}

        {loading ? (
          <p className="text-sm text-faint">Loading…</p>
        ) : files.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-border-strong py-16 text-center">
            <FileIcon className="mx-auto mb-3 h-8 w-8 text-faint" />
            <p className="text-sm text-muted">No files yet. Upload one to get started.</p>
          </div>
        ) : viewMode === 'list' ? (
          <div className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface">
            {files.map((f) => {
              const doc = docs[f.id]
              return (
              <div
                key={f.id}
                className={`flex items-center gap-3 px-4 py-3 ${selected.has(f.id) ? 'bg-primary-soft/40' : ''}`}
              >
                <button
                  onClick={() => toggleSelect(f.id)}
                  aria-label={selected.has(f.id) ? 'Deselect' : 'Select'}
                  title="Select to add to a collection"
                  className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-md border transition ${
                    selected.has(f.id)
                      ? 'border-primary bg-primary text-white'
                      : 'border-border-strong text-transparent hover:text-faint'
                  }`}
                >
                  <CheckIcon className="h-3.5 w-3.5" />
                </button>
                <FileIcon className="h-5 w-5 shrink-0 text-faint" />
                <div className="min-w-0 flex-1">
                  <EditableFileMetadata
                    file={f}
                    onUpdate={(title, description) => updateFileMetadata(f.id, title, description)}
                  />
                  <p className="text-xs text-faint">
                    {formatBytes(f.size_bytes)} · {formatDate(f.created_at)}
                    {f.visibility !== 'private' && ' · link shared'}
                  </p>
                </div>
                {f.public_path && (
                  <PublicBadge
                    onCopy={() => copyText(publicFileUrl(f.public_path!))}
                    onUnpublish={() => unpublishFile(f)}
                  />
                )}
                {doc && <ScopeToggle doc={doc} onChange={(scope) => setScope(doc, scope)} />}
                <IndexBadge doc={doc} />
                <button
                  onClick={() => share(f)}
                  title="Copy 7-day share link"
                  className="rounded-md p-1.5 text-faint hover:bg-surface-hover hover:text-primary"
                >
                  <LinkIcon className="h-[18px] w-[18px]" />
                </button>
                <button
                  onClick={() => remove(f)}
                  title="Delete"
                  className="rounded-md p-1.5 text-faint hover:bg-red-50 hover:text-red-600"
                >
                  <TrashIcon className="h-[18px] w-[18px]" />
                </button>
              </div>
              )
            })}
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {files.map((f) => {
              const doc = docs[f.id]
              return (
                <FileCard
                  key={f.id}
                  file={f}
                  doc={doc}
                  thumbnail={thumbnails[f.id]}
                  selected={selected.has(f.id)}
                  onToggleSelect={() => toggleSelect(f.id)}
                  onDownload={() => download(f)}
                  onShare={() => share(f)}
                  onRemove={() => remove(f)}
                  onSetScope={(scope) => setScope(doc, scope)}
                  onUpdateMetadata={(title, description) => updateFileMetadata(f.id, title, description)}
                  onCopyPublic={() => copyText(publicFileUrl(f.public_path!))}
                  onUnpublish={() => unpublishFile(f)}
                />
              )
            })}
          </div>
        )}

        {linkFor && (
          <p className="mt-4 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
            Share link copied to clipboard (valid 7 days).
          </p>
        )}
      </div>

      <AddToCollectionBar
        kind="file"
        selectedIds={[...selected]}
        onClear={() => setSelected(new Set())}
      />

      {shareResult && (
        <ShareResultModal
          result={shareResult}
          onClose={() => setShareResult(null)}
          onCopy={copyText}
        />
      )}

      {toast && (
        <div className="pointer-events-none fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-lg bg-text px-3 py-2 text-sm font-medium text-surface shadow-lg">
          {toast}
        </div>
      )}
    </div>
  )
}

// Results of a bulk share: a copyable link per file, plus "Copy all". For a
// single file the link is already on the clipboard, but the list still shows it.
function ShareResultModal({
  result,
  onClose,
  onCopy,
}: {
  result: ShareResult
  onClose: () => void
  onCopy: (text: string) => void
}) {
  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="max-h-[80vh] w-full max-w-lg overflow-hidden rounded-2xl border border-border bg-surface shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border px-5 py-3">
          <div>
            <h2 className="text-sm font-semibold text-text">
              {result.items.length} {result.items.length === 1 ? 'link' : 'links'} ready
            </h2>
            <p className="text-xs text-muted">{shareValidityNote(result.mode)}</p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="rounded-md p-1.5 text-faint hover:bg-surface-hover hover:text-text"
          >
            <CloseIcon className="h-4 w-4" />
          </button>
        </div>
        <div className="max-h-[52vh] divide-y divide-border overflow-y-auto">
          {result.items.map((it, i) => (
            <div key={i} className="flex items-center gap-3 px-5 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-text">{it.name}</p>
                <p className="truncate text-xs text-faint">{it.url}</p>
              </div>
              <button
                onClick={() => onCopy(it.url)}
                title="Copy link"
                className="shrink-0 rounded-md p-1.5 text-faint hover:bg-surface-hover hover:text-primary"
              >
                <CopyIcon className="h-4 w-4" />
              </button>
            </div>
          ))}
        </div>
        {result.items.length > 1 && (
          <div className="border-t border-border px-5 py-3">
            <button
              onClick={() => onCopy(result.items.map((it) => it.url).join('\n'))}
              className="w-full rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white transition hover:bg-primary-strong"
            >
              Copy all {result.items.length} links
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

function EditableFileMetadata({
  file,
  onUpdate,
}: {
  file: FileRow
  onUpdate: (title: string | null, description: string | null) => void
}) {
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState(file.title ?? '')
  const [description, setDescription] = useState(file.description ?? '')
  const titleRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editing && titleRef.current) {
      titleRef.current.focus()
    }
  }, [editing])

  function handleSave() {
    const newTitle = title.trim() || null
    const newDescription = description.trim() || null
    onUpdate(newTitle, newDescription)
    setEditing(false)
  }

  function handleCancel() {
    setTitle(file.title ?? '')
    setDescription(file.description ?? '')
    setEditing(false)
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSave()
    }
    if (e.key === 'Escape') {
      handleCancel()
    }
  }

  if (editing) {
    return (
      <div className="space-y-2">
        <input
          ref={titleRef}
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={handleSave}
          placeholder={file.name}
          className="w-full rounded border border-border bg-surface px-2 py-1 text-sm font-medium text-text focus:border-primary focus:outline-none"
        />
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={handleSave}
          placeholder="Add a description..."
          rows={2}
          className="w-full resize-none rounded border border-border bg-surface px-2 py-1 text-xs text-muted focus:border-primary focus:outline-none"
        />
      </div>
    )
  }

  return (
    <button
      onClick={() => setEditing(true)}
      className="group/edit w-full text-left"
      title="Click to edit title and description"
    >
      <div className="flex items-center gap-1">
        <p className="flex-1 truncate text-sm font-medium text-text group-hover/edit:text-primary">
          {file.title || file.name}
        </p>
        <PencilIcon className="h-3 w-3 shrink-0 text-faint opacity-0 transition group-hover/edit:opacity-100" />
      </div>
      {file.description && (
        <p className="mt-0.5 line-clamp-2 text-xs text-muted">
          {file.description}
        </p>
      )}
    </button>
  )
}

function FileCard({
  file,
  doc,
  thumbnail,
  selected,
  onToggleSelect,
  onDownload,
  onShare,
  onRemove,
  onSetScope,
  onUpdateMetadata,
  onCopyPublic,
  onUnpublish,
}: {
  file: FileRow
  doc?: Doc
  thumbnail?: string
  selected: boolean
  onToggleSelect: () => void
  onDownload: () => void
  onShare: () => void
  onRemove: () => void
  onSetScope: (scope: string) => void
  onUpdateMetadata: (title: string | null, description: string | null) => void
  onCopyPublic: () => void
  onUnpublish: () => void
}) {
  const isImage = file.mime_type?.startsWith('image/')

  return (
    <div
      className={`group flex flex-col overflow-hidden rounded-xl border bg-surface transition ${
        selected ? 'border-primary' : 'border-border hover:border-border-strong'
      }`}
    >
      {/* Thumbnail or icon */}
      <button onClick={onDownload} className="block">
        {isImage && thumbnail ? (
          <img
            src={thumbnail}
            alt={file.name}
            loading="lazy"
            className="h-36 w-full object-cover"
            onError={(e) => {
              const img = e.target as HTMLImageElement
              img.style.display = 'none'
            }}
          />
        ) : (
          <div className="flex h-36 w-full items-center justify-center bg-surface-2 text-faint">
            <FileIcon className="h-12 w-12" />
          </div>
        )}
      </button>

      {/* File info */}
      <div className="flex flex-1 flex-col gap-1.5 px-4 py-3">
        <EditableFileMetadata
          file={file}
          onUpdate={onUpdateMetadata}
        />
        <p className="text-xs text-faint">
          {formatBytes(file.size_bytes)} · {formatDate(file.created_at)}
        </p>
        {file.public_path ? (
          <PublicBadge onCopy={onCopyPublic} onUnpublish={onUnpublish} />
        ) : (
          file.visibility !== 'private' && <p className="text-xs text-muted">Link shared</p>
        )}
        {doc && <IndexBadge doc={doc} />}
      </div>

      {/* Footer: scope toggle + actions */}
      <div className="flex items-center gap-1 border-t border-border px-3 py-2">
        {doc && <ScopeToggle doc={doc} onChange={onSetScope} />}

        <div className="ml-auto flex shrink-0 items-center gap-1 opacity-100 transition md:opacity-0 md:group-hover:opacity-100">
          <button
            onClick={onDownload}
            title="Download"
            className="rounded-md p-1 text-faint hover:bg-surface-hover hover:text-muted"
          >
            <DownloadIcon className="h-4 w-4" />
          </button>
          <button
            onClick={onShare}
            title="Copy 7-day share link"
            className="rounded-md p-1 text-faint hover:bg-surface-hover hover:text-primary"
          >
            <LinkIcon className="h-4 w-4" />
          </button>
          <button
            onClick={onToggleSelect}
            title="Select"
            className={`rounded-md p-1 hover:bg-surface-hover ${selected ? 'text-primary' : 'text-faint hover:text-muted'}`}
          >
            <CheckIcon className="h-4 w-4" />
          </button>
          <button
            onClick={onRemove}
            title="Delete"
            className="rounded-md p-1 text-faint hover:bg-surface-hover hover:text-red-600"
          >
            <TrashIcon className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  )
}

// Whether an indexed document is part of the shared team knowledge base or
// private to the owner. (Only the extracted chunks are shared — the raw file
// in storage stays private regardless.)
function ScopeToggle({ doc, onChange }: { doc: Doc; onChange: (scope: string) => void }) {
  const shared = doc.scope === 'workspace'
  return (
    <button
      onClick={() => onChange(shared ? 'private' : 'workspace')}
      title={
        shared
          ? 'In the team knowledge base — tap to make it searchable only by you'
          : 'Only you can search this — tap to add it to the team knowledge base'
      }
      className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${
        shared ? 'bg-primary-soft text-primary' : 'bg-surface-2 text-muted'
      }`}
    >
      {shared ? 'Team knowledge' : 'Only me'}
    </button>
  )
}

// A file published to the public bucket: click the pill to copy its permanent
// URL, the × to unpublish (drops the public copy; the private original stays).
function PublicBadge({ onCopy, onUnpublish }: { onCopy: () => void; onUnpublish: () => void }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-emerald-100 pl-2 pr-1 py-0.5 text-[10px] font-medium text-emerald-700">
      <button
        onClick={onCopy}
        title="Copy the permanent public URL"
        className="inline-flex items-center gap-1 hover:underline"
      >
        <GlobeIcon className="h-3 w-3" /> Public
      </button>
      <button
        onClick={onUnpublish}
        title="Make private again"
        aria-label="Unpublish"
        className="rounded-full p-0.5 hover:bg-emerald-200"
      >
        <CloseIcon className="h-2.5 w-2.5" />
      </button>
    </span>
  )
}

// Indexing status for a PDF (so the knowledge-base pipeline is observable).
function IndexBadge({ doc }: { doc?: Doc }) {
  if (!doc) return null
  if (doc.status === 'done') {
    return (
      <span className="shrink-0 rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-medium text-emerald-700">
        ✓ Indexed{doc.chunk_count ? ` · ${doc.chunk_count}` : ''}
      </span>
    )
  }
  if (doc.status === 'error') {
    return (
      <span
        title={doc.error ?? 'Indexing failed'}
        className="shrink-0 rounded-full bg-red-100 px-2 py-0.5 text-[10px] font-medium text-red-700"
      >
        Index failed
      </span>
    )
  }
  return (
    <span className="shrink-0 animate-pulse rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-700">
      Indexing…
    </span>
  )
}
