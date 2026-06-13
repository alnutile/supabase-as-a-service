import { useCallback, useEffect, useState } from 'react'
import type { Database } from '../lib/database.types'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import { formatDate } from '../lib/util'
import { LinkIcon, PlusIcon, TrashIcon } from '../components/icons'
import {
  PLUGINS,
  PLUGIN_CATEGORIES,
  PLUGINS_REPO_URL,
  pluginUrl,
  type Plugin,
} from '../lib/plugins'

type InstalledPlugin = Database['public']['Tables']['plugins']['Row']

export default function PluginsPage() {
  const { user } = useAuth()
  const [installed, setInstalled] = useState<InstalledPlugin[]>([])
  const [isAdmin, setIsAdmin] = useState(false)
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')

  const load = useCallback(async () => {
    const { data } = await supabase
      .from('plugins')
      .select('*')
      .order('created_at', { ascending: false })
    setInstalled(data ?? [])
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

  const installedSlugs = new Set(installed.map((p) => p.slug))

  async function install(p: Plugin) {
    if (!isAdmin) return
    await supabase.from('plugins').insert({
      slug: p.slug,
      name: p.name,
      description: p.description,
      category: p.category,
      source_url: pluginUrl(p.slug),
      installed_by: user!.id,
    })
    load()
  }

  async function toggle(row: InstalledPlugin) {
    if (!isAdmin) return
    await supabase
      .from('plugins')
      .update({ enabled: !row.enabled, updated_at: new Date().toISOString() })
      .eq('id', row.id)
    load()
  }

  async function saveNotes(row: InstalledPlugin, notes: string) {
    if (!isAdmin || notes === (row.notes ?? '')) return
    await supabase
      .from('plugins')
      .update({ notes, updated_at: new Date().toISOString() })
      .eq('id', row.id)
    load()
  }

  async function remove(row: InstalledPlugin) {
    if (!isAdmin) return
    await supabase.from('plugins').delete().eq('id', row.id)
    load()
  }

  // Available = catalog minus what's already installed, filtered by search.
  const q = query.trim().toLowerCase()
  const matches = (p: Plugin) =>
    !q ||
    p.name.toLowerCase().includes(q) ||
    p.description.toLowerCase().includes(q) ||
    p.category.toLowerCase().includes(q) ||
    p.slug.toLowerCase().includes(q) ||
    (p.requires ?? []).some((r) => r.toLowerCase().includes(q))

  const available = PLUGINS.filter((p) => !installedSlugs.has(p.slug) && matches(p))
  const groups = PLUGIN_CATEGORIES.map((cat) => ({
    cat,
    items: available.filter((p) => p.category === cat),
  })).filter((g) => g.items.length > 0)

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl px-6 py-8">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-slate-900">Plugins</h1>
            <p className="mt-1 text-sm text-slate-500">
              Set up Supabase Edge Function examples — email, payments, bots, headless browsers,
              AI providers, and more. Track what this workspace has installed, then browse the
              catalog to add more.
            </p>
          </div>
          <a
            href={PLUGINS_REPO_URL}
            target="_blank"
            rel="noreferrer"
            className="mt-1 flex shrink-0 items-center gap-1 text-xs font-medium text-brand-600 hover:text-brand-700"
          >
            <LinkIcon className="h-3.5 w-3.5" /> All examples on GitHub
          </a>
        </div>

        {/* Installed */}
        <section className="mt-6">
          <h2 className="text-sm font-semibold text-slate-700">
            Installed{installed.length > 0 && <span className="ml-1 text-slate-400">· {installed.length}</span>}
          </h2>
          {loading ? (
            <p className="mt-3 text-sm text-slate-400">Loading…</p>
          ) : installed.length === 0 ? (
            <p className="mt-3 rounded-xl border border-dashed border-slate-200 bg-white px-4 py-6 text-center text-sm text-slate-400">
              Nothing installed yet. {isAdmin ? 'Add one from the catalog below.' : 'An admin can add plugins from the catalog below.'}
            </p>
          ) : (
            <div className="mt-3 space-y-2">
              {installed.map((row) => (
                <InstalledRow
                  key={row.id}
                  row={row}
                  isAdmin={isAdmin}
                  onToggle={() => toggle(row)}
                  onSaveNotes={(notes) => saveNotes(row, notes)}
                  onRemove={() => remove(row)}
                />
              ))}
            </div>
          )}
        </section>

        {/* Available catalog */}
        <section className="mt-8">
          <h2 className="text-sm font-semibold text-slate-700">Available</h2>
          <p className="mt-1 text-sm text-slate-500">
            Open one to read its source, then drop it into{' '}
            <code className="rounded bg-slate-100 px-1">supabase/functions</code> to deploy it.
            {isAdmin && ' Use “Add” to track it here once it’s set up.'}
          </p>

          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search plugins — e.g. email, stripe, redis, puppeteer…"
            className="mt-4 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
          />

          <div className="mt-4 space-y-5">
            {groups.length === 0 && (
              <p className="text-sm text-slate-400">
                {q ? `No plugins match “${query}”.` : 'Everything in the catalog is installed.'}
              </p>
            )}
            {groups.map(({ cat, items }) => (
              <div key={cat}>
                <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">{cat}</h3>
                <div className="mt-2 space-y-2">
                  {items.map((p) => (
                    <CatalogRow key={p.slug} plugin={p} isAdmin={isAdmin} onInstall={() => install(p)} />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  )
}

function InstalledRow({
  row,
  isAdmin,
  onToggle,
  onSaveNotes,
  onRemove,
}: {
  row: InstalledPlugin
  isAdmin: boolean
  onToggle: () => void
  onSaveNotes: (notes: string) => void
  onRemove: () => void
}) {
  const [notes, setNotes] = useState(row.notes ?? '')

  useEffect(() => {
    setNotes(row.notes ?? '')
  }, [row.notes])

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-3">
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium text-slate-800">{row.name}</span>
        <code className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[10px] text-slate-500">
          {row.slug}
        </code>
        {!row.enabled && (
          <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-500">
            paused
          </span>
        )}
        <div className="ml-auto flex items-center gap-1">
          {row.source_url && (
            <a
              href={row.source_url}
              target="_blank"
              rel="noreferrer"
              title="View source"
              className="rounded-md p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
            >
              <LinkIcon className="h-4 w-4" />
            </a>
          )}
          {isAdmin && (
            <>
              <button
                onClick={onToggle}
                className="rounded-md border border-slate-300 px-2 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50"
              >
                {row.enabled ? 'Pause' : 'Enable'}
              </button>
              <button
                onClick={onRemove}
                title="Remove"
                className="rounded-md p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600"
              >
                <TrashIcon className="h-4 w-4" />
              </button>
            </>
          )}
        </div>
      </div>
      {row.description && <p className="mt-0.5 text-xs text-slate-500">{row.description}</p>}
      {isAdmin ? (
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          onBlur={() => onSaveNotes(notes)}
          rows={2}
          placeholder="Setup notes — secrets set, provider wired up, endpoint URL…"
          className="mt-2 w-full resize-y rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
        />
      ) : (
        row.notes && <p className="mt-2 whitespace-pre-wrap text-xs text-slate-500">{row.notes}</p>
      )}
      <p className="mt-1 text-[11px] text-slate-400">Added {formatDate(row.created_at)}</p>
    </div>
  )
}

function CatalogRow({
  plugin,
  isAdmin,
  onInstall,
}: {
  plugin: Plugin
  isAdmin: boolean
  onInstall: () => void
}) {
  return (
    <div className="group rounded-lg border border-slate-200 bg-white p-3 transition hover:border-brand-300">
      <div className="flex items-center gap-2">
        <a
          href={pluginUrl(plugin.slug)}
          target="_blank"
          rel="noreferrer"
          className="text-sm font-medium text-slate-800 hover:text-brand-700"
        >
          {plugin.name}
        </a>
        <code className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[10px] text-slate-500">
          {plugin.slug}
        </code>
        <div className="ml-auto flex items-center gap-1">
          <a
            href={pluginUrl(plugin.slug)}
            target="_blank"
            rel="noreferrer"
            title="View source"
            className="rounded-md p-1.5 text-slate-300 hover:bg-slate-100 hover:text-slate-700"
          >
            <LinkIcon className="h-4 w-4" />
          </a>
          {isAdmin && (
            <button
              onClick={onInstall}
              className="flex items-center gap-1 rounded-md border border-slate-300 px-2 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50"
            >
              <PlusIcon className="h-3.5 w-3.5" /> Add
            </button>
          )}
        </div>
      </div>
      <p className="mt-0.5 text-xs text-slate-500">{plugin.description}</p>
      {plugin.requires && plugin.requires.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {plugin.requires.map((r) => (
            <span
              key={r}
              className="rounded bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-700"
            >
              needs {r}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}
