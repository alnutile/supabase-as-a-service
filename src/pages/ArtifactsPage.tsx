import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { Database } from '../lib/database.types'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import { formatDate } from '../lib/util'
import { ArtifactIcon, GlobeIcon, LinkIcon, LockIcon, PlusIcon } from '../components/icons'

type Artifact = Database['public']['Tables']['artifacts']['Row']

const VIS_ICON = { private: LockIcon, unlisted: LinkIcon, public: GlobeIcon }

export default function ArtifactsPage() {
  const navigate = useNavigate()
  const { user } = useAuth()
  const [artifacts, setArtifacts] = useState<Artifact[]>([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    const { data } = await supabase
      .from('artifacts')
      .select('*')
      .order('updated_at', { ascending: false })
    setArtifacts(data ?? [])
    setLoading(false)
  }, [])

  useEffect(() => {
    load()
  }, [load])

  async function create() {
    const { data, error } = await supabase
      .from('artifacts')
      .insert({
        owner_id: user!.id,
        title: 'Untitled artifact',
        type: 'markdown',
        content: '# Untitled\n\nStart writing…',
        visibility: 'private',
      })
      .select()
      .single()
    if (!error && data) navigate(`/artifacts/${data.id}`)
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-4xl px-6 py-8">
        <div className="mb-6 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-slate-900">Artifacts</h1>
            <p className="mt-1 text-sm text-slate-500">
              Documents and snippets you can keep private or share.
            </p>
          </div>
          <button
            onClick={create}
            className="flex items-center gap-2 rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-brand-700"
          >
            <PlusIcon className="h-4 w-4" /> New artifact
          </button>
        </div>

        {loading ? (
          <p className="text-sm text-slate-400">Loading…</p>
        ) : artifacts.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-slate-300 py-16 text-center">
            <ArtifactIcon className="mx-auto mb-3 h-8 w-8 text-slate-300" />
            <p className="text-sm text-slate-500">No artifacts yet.</p>
            <button onClick={create} className="mt-3 text-sm font-medium text-brand-600 hover:underline">
              Create your first one
            </button>
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {artifacts.map((a) => {
              const VisIcon = VIS_ICON[a.visibility]
              return (
                <button
                  key={a.id}
                  onClick={() => navigate(`/artifacts/${a.id}`)}
                  className="group rounded-xl border border-slate-200 bg-white p-4 text-left transition hover:border-brand-300 hover:shadow-sm"
                >
                  <div className="flex items-start justify-between">
                    <h3 className="truncate font-medium text-slate-800 group-hover:text-brand-700">
                      {a.title}
                    </h3>
                    <VisIcon className="h-4 w-4 shrink-0 text-slate-400" />
                  </div>
                  <p className="mt-1 line-clamp-2 text-xs text-slate-500">
                    {a.content.replace(/[#*`>]/g, '').slice(0, 120) || 'Empty'}
                  </p>
                  <p className="mt-3 text-[11px] uppercase tracking-wide text-slate-400">
                    {a.type} · {formatDate(a.updated_at)}
                  </p>
                </button>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
