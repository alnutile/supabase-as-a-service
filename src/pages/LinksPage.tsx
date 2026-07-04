import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Database } from '../lib/database.types'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import { fetchLinkMeta, normalizeUrl } from '../lib/links'
import { AddToCollectionBar } from '../components/AddToCollectionBar'
import {
  CheckIcon,
  CollectionIcon,
  CopyIcon,
  GlobeIcon,
  LinkIcon,
  LoopIcon,
  PlusIcon,
  TrashIcon,
} from '../components/icons'

type Link = Database['public']['Tables']['links']['Row']
type Collection = Database['public']['Tables']['collections']['Row']

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

export default function LinksPage() {
  const { user } = useAuth()
  const [links, setLinks] = useState<Link[]>([])
  const [collections, setCollections] = useState<Collection[]>([])
  const [members, setMembers] = useState<Record<string, Set<string>>>({}) // collection_id -> link ids
  const [loading, setLoading] = useState(true)

  const [quickUrl, setQuickUrl] = useState('')
  const [adding, setAdding] = useState(false)
  const [fetchingIds, setFetchingIds] = useState<Set<string>>(new Set())
  const [screenshots, setScreenshots] = useState<Record<string, string>>({}) // link id -> signed URL
  const [activeCollection, setActiveCollection] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())

  const load = useCallback(async () => {
    const [lRes, cRes, mRes] = await Promise.all([
      supabase.from('links').select('*').order('created_at', { ascending: false }),
      supabase.from('collections').select('*').order('name', { ascending: true }),
      supabase.from('collection_links').select('collection_id, link_id'),
    ])
    setLinks(lRes.data ?? [])
    setCollections(cRes.data ?? [])
    const map: Record<string, Set<string>> = {}
    for (const row of mRes.data ?? []) {
      const set = (map[row.collection_id] ??= new Set())
      set.add(row.link_id)
    }
    setMembers(map)
    setLoading(false)

    // Captured screenshots live in a private bucket — mint short-lived signed
    // URLs in one batch and prefer them over the page's og:image.
    const withShots = (lRes.data ?? []).filter((l) => l.screenshot_path)
    if (withShots.length) {
      const { data: signed } = await supabase.storage
        .from('link-screenshots')
        .createSignedUrls(withShots.map((l) => l.screenshot_path!), 3600)
      const map2: Record<string, string> = {}
      withShots.forEach((l, i) => {
        const s = signed?.[i]
        if (s?.signedUrl) map2[l.id] = s.signedUrl
      })
      setScreenshots(map2)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const selectedIds = useMemo(() => [...selected], [selected])

  const visible = useMemo(() => {
    if (!activeCollection) return links
    const set = members[activeCollection] ?? new Set()
    return links.filter((l) => set.has(l.id))
  }, [links, members, activeCollection])

  // --- mutations -----------------------------------------------------------

  function markFetching(id: string, on: boolean) {
    setFetchingIds((prev) => {
      const next = new Set(prev)
      if (on) next.add(id)
      else next.delete(id)
      return next
    })
  }

  // Insert the link immediately (hostname as a placeholder title), then enrich
  // it with server-fetched metadata — adding never blocks on a slow site.
  async function addQuick() {
    const url = normalizeUrl(quickUrl)
    if (!url || !user || adding) return
    setAdding(true)
    const { data, error } = await supabase
      .from('links')
      .insert({ owner_id: user.id, url, title: hostOf(url), visibility: 'private' })
      .select('*')
      .single()
    setAdding(false)
    if (error || !data) return
    setLinks((prev) => [data, ...prev])
    setQuickUrl('')
    if (activeCollection) {
      await supabase.from('collection_links').upsert(
        { collection_id: activeCollection, link_id: data.id, added_by: user.id },
        { onConflict: 'collection_id,link_id', ignoreDuplicates: true },
      )
      setMembers((prev) => {
        const set = new Set(prev[activeCollection] ?? [])
        set.add(data.id)
        return { ...prev, [activeCollection]: set }
      })
    }
    refreshMeta(data.id, url)
  }

  async function refreshMeta(id: string, url: string) {
    markFetching(id, true)
    try {
      const meta = await fetchLinkMeta(url)
      if (!meta) return
      const patch = {
        title: meta.title || hostOf(url),
        description: meta.description,
        image_url: meta.image_url,
        favicon_url: meta.favicon_url,
      }
      const { data } = await supabase.from('links').update(patch).eq('id', id).select('*').single()
      if (data) setLinks((prev) => prev.map((l) => (l.id === id ? data : l)))
    } finally {
      markFetching(id, false)
    }
  }

  async function patchLink(id: string, patch: Partial<Link>) {
    setLinks((prev) => prev.map((l) => (l.id === id ? { ...l, ...patch } : l)))
    await supabase.from('links').update(patch).eq('id', id)
  }

  async function deleteLink(id: string) {
    setLinks((prev) => prev.filter((l) => l.id !== id))
    setSelected((prev) => {
      const next = new Set(prev)
      next.delete(id)
      return next
    })
    await supabase.from('links').delete().eq('id', id)
  }

  async function removeFromActive(linkId: string) {
    if (!activeCollection) return
    await supabase.from('collection_links').delete().eq('collection_id', activeCollection).eq('link_id', linkId)
    setMembers((prev) => {
      const set = new Set(prev[activeCollection] ?? [])
      set.delete(linkId)
      return { ...prev, [activeCollection]: set }
    })
  }

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  // --- render --------------------------------------------------------------

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-6xl px-6 py-8">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight text-text">
            <LinkIcon className="h-6 w-6 text-muted" /> Links
          </h1>
          <p className="mt-1 text-sm text-muted">
            Paste a URL — the title, description and preview fill in automatically. Share with the workspace and file into
            collections.
          </p>
        </div>

        {/* Quick add */}
        <div className="mt-5 flex items-center gap-2">
          <input
            value={quickUrl}
            onChange={(e) => setQuickUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                addQuick()
              }
            }}
            placeholder="Paste a URL and press Enter…"
            inputMode="url"
            className="flex-1 rounded-lg border border-border-strong bg-surface px-3 py-2.5 text-sm outline-none focus:border-primary focus:ring-1 focus:ring-primary-soft"
          />
          <button
            onClick={addQuick}
            disabled={!normalizeUrl(quickUrl) || adding}
            className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2.5 text-sm font-semibold text-white transition hover:bg-primary-strong disabled:opacity-50"
          >
            <PlusIcon className="h-4 w-4" /> Add
          </button>
        </div>

        {/* Collection filter bar */}
        {collections.length > 0 && (
          <div className="mt-5 flex flex-wrap items-center gap-2">
            <button
              onClick={() => setActiveCollection(null)}
              className={`rounded-full border px-3 py-1.5 text-sm font-medium transition ${
                activeCollection === null
                  ? 'border-primary bg-primary-soft text-primary'
                  : 'border-border text-muted hover:bg-surface-hover'
              }`}
            >
              All ({links.length})
            </button>
            {collections.map((c) => (
              <button
                key={c.id}
                onClick={() => setActiveCollection(c.id)}
                className={`flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm font-medium transition ${
                  activeCollection === c.id
                    ? 'border-primary bg-primary-soft text-primary'
                    : 'border-border text-muted hover:bg-surface-hover'
                }`}
              >
                <CollectionIcon className="h-3.5 w-3.5" />
                {c.name} ({(members[c.id] ?? new Set()).size})
              </button>
            ))}
          </div>
        )}

        {/* Card grid */}
        <div className="mt-5">
          {loading ? (
            <p className="text-sm text-muted">Loading…</p>
          ) : visible.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border py-16 text-center text-sm text-muted">
              {activeCollection ? 'No links in this collection yet.' : 'Nothing here yet — paste your first URL above.'}
            </div>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {visible.map((l) => (
                <LinkCard
                  key={l.id}
                  link={l}
                  screenshotUrl={screenshots[l.id]}
                  fetching={fetchingIds.has(l.id)}
                  selected={selected.has(l.id)}
                  onToggleSelect={() => toggleSelect(l.id)}
                  onToggleVisibility={() =>
                    patchLink(l.id, { visibility: l.visibility === 'workspace' ? 'private' : 'workspace' })
                  }
                  onRefresh={() => refreshMeta(l.id, l.url)}
                  onDelete={() => deleteLink(l.id)}
                  onRemoveFromCollection={activeCollection ? () => removeFromActive(l.id) : undefined}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      <AddToCollectionBar kind="link" selectedIds={selectedIds} onClear={() => setSelected(new Set())} />
    </div>
  )
}

function LinkCard({
  link,
  screenshotUrl,
  fetching,
  selected,
  onToggleSelect,
  onToggleVisibility,
  onRefresh,
  onDelete,
  onRemoveFromCollection,
}: {
  link: Link
  screenshotUrl?: string
  fetching: boolean
  selected: boolean
  onToggleSelect: () => void
  onToggleVisibility: () => void
  onRefresh: () => void
  onDelete: () => void
  onRemoveFromCollection?: () => void
}) {
  const [copied, setCopied] = useState(false)
  const host = hostOf(link.url)
  // A captured screenshot (signed URL) beats the page's own og:image.
  const preview = screenshotUrl ?? link.image_url

  async function copyUrl() {
    try {
      await navigator.clipboard.writeText(link.url)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // ignore
    }
  }

  return (
    <div
      className={`group flex flex-col overflow-hidden rounded-xl border bg-surface transition ${
        selected ? 'border-primary' : 'border-border hover:border-border-strong'
      }`}
    >
      {/* Preview image (og:image; screenshot later) */}
      <a href={link.url} target="_blank" rel="noreferrer" className="block">
        {preview ? (
          <img
            src={preview}
            alt=""
            loading="lazy"
            className="h-36 w-full object-cover"
            onError={(e) => {
              // A dead preview URL leaves an ugly broken-image box — hide it.
              const img = e.target as HTMLImageElement
              img.style.display = 'none'
            }}
          />
        ) : (
          <div className="flex h-36 w-full items-center justify-center bg-surface-2 text-faint">
            <GlobeIcon className="h-8 w-8" />
          </div>
        )}
      </a>

      <div className="flex flex-1 flex-col gap-1.5 px-4 py-3">
        <a href={link.url} target="_blank" rel="noreferrer" className="flex items-start gap-2">
          {link.favicon_url && (
            <img
              src={link.favicon_url}
              alt=""
              loading="lazy"
              className="mt-0.5 h-4 w-4 shrink-0 rounded-sm"
              onError={(e) => {
                const img = e.target as HTMLImageElement
                img.style.display = 'none'
              }}
            />
          )}
          <span className="line-clamp-2 text-sm font-semibold text-text group-hover:text-primary">
            {link.title || host}
          </span>
        </a>
        <p className="truncate text-[11px] uppercase tracking-wide text-faint">{host}</p>
        {fetching ? (
          <p className="text-xs text-faint">Fetching preview…</p>
        ) : (
          link.description && <p className="line-clamp-3 text-xs text-muted">{link.description}</p>
        )}
      </div>

      {/* Footer: visibility + actions */}
      <div className="flex items-center gap-1 border-t border-border px-3 py-2">
        <button
          onClick={onToggleVisibility}
          title={link.visibility === 'workspace' ? 'Shared with the workspace' : 'Private to you'}
          className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide transition ${
            link.visibility === 'workspace' ? 'bg-primary-soft text-primary' : 'bg-surface-2 text-faint hover:text-muted'
          }`}
        >
          {link.visibility === 'workspace' ? 'Team' : 'Mine'}
        </button>

        <div className="ml-auto flex shrink-0 items-center gap-1 opacity-100 transition md:opacity-0 md:group-hover:opacity-100">
          {onRemoveFromCollection && (
            <button
              onClick={onRemoveFromCollection}
              title="Remove from this collection"
              className="rounded-md p-1 text-faint hover:bg-surface-hover hover:text-muted"
            >
              <CollectionIcon className="h-4 w-4" />
            </button>
          )}
          <button
            onClick={copyUrl}
            title={copied ? 'Copied!' : 'Copy URL'}
            className={`rounded-md p-1 hover:bg-surface-hover ${copied ? 'text-primary' : 'text-faint hover:text-muted'}`}
          >
            <CopyIcon className="h-4 w-4" />
          </button>
          <button
            onClick={onRefresh}
            disabled={fetching}
            title="Refresh title & preview"
            className="rounded-md p-1 text-faint hover:bg-surface-hover hover:text-muted disabled:opacity-50"
          >
            <LoopIcon className={`h-4 w-4 ${fetching ? 'animate-spin' : ''}`} />
          </button>
          <button
            onClick={onToggleSelect}
            title="Select"
            className={`rounded-md p-1 hover:bg-surface-hover ${selected ? 'text-primary' : 'text-faint hover:text-muted'}`}
          >
            <CheckIcon className="h-4 w-4" />
          </button>
          <button
            onClick={onDelete}
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
