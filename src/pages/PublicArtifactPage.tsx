import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import type { Database } from '../lib/database.types'
import { standalonePageUrl, supabase } from '../lib/supabase'
import { Markdown } from '../components/Markdown'

type Artifact = Database['public']['Tables']['artifacts']['Row']

export default function PublicArtifactPage() {
  const { slug } = useParams()
  const [artifact, setArtifact] = useState<Artifact | null>(null)
  const [status, setStatus] = useState<'loading' | 'ok' | 'missing'>('loading')

  useEffect(() => {
    if (!slug) return
    // RLS only returns rows whose visibility is public/unlisted, so anon read is safe.
    supabase
      .from('artifacts')
      .select('*')
      .eq('public_slug', slug)
      .maybeSingle()
      .then(({ data }) => {
        if (data) {
          setArtifact(data)
          setStatus('ok')
        } else {
          setStatus('missing')
        }
      })
  }, [slug])

  if (status === 'loading') {
    return <div className="flex h-full items-center justify-center text-sm text-faint">Loading…</div>
  }

  if (status === 'missing' || !artifact) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
        <p className="text-lg font-semibold text-text">This artifact isn’t available</p>
        <p className="text-sm text-muted">It may be private or the link is incorrect.</p>
        <Link to="/" className="text-sm font-medium text-primary hover:underline">
          Go to the intranet
        </Link>
      </div>
    )
  }

  return (
    <div className="min-h-full bg-surface">
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-6 py-4">
          <Link to="/" className="flex items-center gap-2 text-sm font-semibold text-text">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary text-white">
              ✺
            </span>
            Intranet
          </Link>
          <span className="rounded-full bg-surface-2 px-2.5 py-1 text-xs font-medium text-muted">
            Shared {artifact.visibility === 'public' ? 'publicly' : 'via link'}
          </span>
        </div>
      </header>
      <article className="mx-auto max-w-3xl px-6 py-10">
        <h1 className="mb-6 text-3xl font-bold tracking-tight text-text">{artifact.title}</h1>
        {artifact.type === 'html' ? (
          <>
            <iframe
              title={artifact.title}
              sandbox="allow-scripts"
              srcDoc={artifact.content}
              className="h-[70vh] w-full rounded-xl border border-border"
            />
            {artifact.public_slug && (
              <a
                href={standalonePageUrl(artifact.public_slug)}
                target="_blank"
                rel="noreferrer"
                className="mt-3 inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:underline"
              >
                Open full screen ↗
              </a>
            )}
          </>
        ) : artifact.type === 'markdown' ? (
          <Markdown>{artifact.content}</Markdown>
        ) : (
          <pre className="overflow-x-auto rounded-xl bg-slate-900 p-4 text-sm text-slate-100">
            {artifact.content}
          </pre>
        )}
      </article>
    </div>
  )
}
