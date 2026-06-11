import { useCallback, useEffect, useRef, useState } from 'react'
import type { Database } from '../lib/database.types'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import { formatBytes, formatDate } from '../lib/util'
import { FileIcon, LinkIcon, TrashIcon, UploadIcon } from '../components/icons'

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
  const inputRef = useRef<HTMLInputElement>(null)

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
    for (const d of data ?? []) map[d.file_id] = d
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

  async function handleUpload(fileList: FileList | null) {
    if (!fileList || fileList.length === 0) return
    setUploading(true)
    setError(null)
    try {
      for (const file of Array.from(fileList)) {
        const path = `${user!.id}/${crypto.randomUUID()}/${file.name}`
        // Read the bytes up front. Some mobile file sources hand over a virtual
        // (cloud-backed) handle the browser can't stream — materializing it here
        // makes the upload reliable and surfaces a real error if it can't.
        let body: ArrayBuffer
        try {
          body = await file.arrayBuffer()
        } catch {
          throw new Error(
            `Couldn’t read “${file.name}”. Some apps hand over files the browser can’t read directly — download it to your device first, then upload.`,
          )
        }
        if (body.byteLength === 0) {
          throw new Error(`“${file.name}” came through empty — download it to your device first, then upload.`)
        }
        const { error: upErr } = await supabase.storage
          .from(BUCKET)
          .upload(path, body, { upsert: false, contentType: file.type || 'application/octet-stream' })
        if (upErr) throw upErr
        const { error: rowErr } = await supabase.from('files').insert({
          owner_id: user!.id,
          bucket: BUCKET,
          path,
          name: file.name,
          mime_type: file.type || null,
          size_bytes: body.byteLength,
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
            <h1 className="text-2xl font-semibold tracking-tight text-slate-900">Files</h1>
            <p className="mt-1 text-sm text-slate-500">
              Private by default. Create a share link when you want to hand one out.
            </p>
          </div>
          <button
            onClick={() => inputRef.current?.click()}
            disabled={uploading}
            className="flex items-center gap-2 rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-brand-700 disabled:opacity-60"
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
          <p className="text-sm text-slate-400">Loading…</p>
        ) : files.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-slate-300 py-16 text-center">
            <FileIcon className="mx-auto mb-3 h-8 w-8 text-slate-300" />
            <p className="text-sm text-slate-500">No files yet. Upload one to get started.</p>
          </div>
        ) : (
          <div className="divide-y divide-slate-100 overflow-hidden rounded-xl border border-slate-200 bg-white">
            {files.map((f) => (
              <div key={f.id} className="flex items-center gap-3 px-4 py-3">
                <FileIcon className="h-5 w-5 shrink-0 text-slate-400" />
                <button
                  onClick={() => download(f)}
                  className="min-w-0 flex-1 text-left"
                  title="Download"
                >
                  <p className="truncate text-sm font-medium text-slate-800 hover:text-brand-600">
                    {f.name}
                  </p>
                  <p className="text-xs text-slate-400">
                    {formatBytes(f.size_bytes)} · {formatDate(f.created_at)}
                    {f.visibility !== 'private' && ' · link shared'}
                  </p>
                </button>
                <IndexBadge doc={docs[f.id]} />
                <button
                  onClick={() => share(f)}
                  title="Copy 7-day share link"
                  className="rounded-md p-1.5 text-slate-400 hover:bg-slate-100 hover:text-brand-600"
                >
                  <LinkIcon className="h-[18px] w-[18px]" />
                </button>
                <button
                  onClick={() => remove(f)}
                  title="Delete"
                  className="rounded-md p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600"
                >
                  <TrashIcon className="h-[18px] w-[18px]" />
                </button>
              </div>
            ))}
          </div>
        )}

        {linkFor && (
          <p className="mt-4 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
            Share link copied to clipboard (valid 7 days).
          </p>
        )}
      </div>
    </div>
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
