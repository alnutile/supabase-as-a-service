import { useCallback, useEffect, useRef, useState } from 'react'
import type { Database } from '../lib/database.types'
import { supabase } from '../lib/supabase'
import { uploadPickedFile } from '../lib/upload'
import { useAuth } from '../contexts/AuthContext'
import { formatBytes, formatDate } from '../lib/util'
import { CheckIcon, FileIcon, LinkIcon, TrashIcon, UploadIcon } from '../components/icons'
import { AddToCollectionBar } from '../components/AddToCollectionBar'

type FileRow = Database['public']['Tables']['files']['Row']
type Doc = Database['public']['Tables']['documents']['Row']
const BUCKET = 'files'

export default function FilesPage() {
  const { user } = useAuth()
  const [files, setFiles] = useState<FileRow[]>([])
  const [loading, setLoading] = useState(true)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [linkFor, setLinkFor] = useState<{ id: string; url: string } | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const inputRef = useRef<HTMLInputElement>(null)

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const [docs, setDocs] = useState<Record<string, Doc>>({})

  const load = useCallback(async () => {
    const { data } = await supabase
      .from('files')
      .select('*')
      .order('created_at', { ascending: false })
    setFiles(data ?? [])
    setLoading(false)
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

  async function remove(f: FileRow) {
    if (!confirm(`Delete "${f.name}"?`)) return
    await supabase.storage.from(f.bucket).remove([f.path])
    await supabase.from('files').delete().eq('id', f.id)
    load()
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-4xl px-6 py-8">
        <div className="mb-6 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-text">Files</h1>
            <p className="mt-1 text-sm text-muted">
              Private by default. Create a share link, or select files to add them to a collection to chat with.
            </p>
          </div>
          <button
            onClick={() => inputRef.current?.click()}
            disabled={uploading}
            className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white transition hover:bg-primary-strong disabled:opacity-60"
          >
            <UploadIcon className="h-4 w-4" /> {uploading ? 'Uploading…' : 'Upload'}
          </button>
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

        {loading ? (
          <p className="text-sm text-faint">Loading…</p>
        ) : files.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-border-strong py-16 text-center">
            <FileIcon className="mx-auto mb-3 h-8 w-8 text-faint" />
            <p className="text-sm text-muted">No files yet. Upload one to get started.</p>
          </div>
        ) : (
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
                <button
                  onClick={() => download(f)}
                  className="min-w-0 flex-1 text-left"
                  title="Download"
                >
                  <p className="truncate text-sm font-medium text-text hover:text-primary">
                    {f.name}
                  </p>
                  <p className="text-xs text-faint">
                    {formatBytes(f.size_bytes)} · {formatDate(f.created_at)}
                    {f.visibility !== 'private' && ' · link shared'}
                  </p>
                </button>
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
