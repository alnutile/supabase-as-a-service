import { useEffect } from 'react'
import { Link, Navigate, useParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { ArtifactFrame } from '../components/ArtifactFrame'
import { ArtifactPasswordGate, useSharedArtifact } from '../components/ArtifactPasswordGate'

// Chrome-free, full-viewport renderer for a shared `html` artifact — the
// "standalone page" / "full screen" links target this route. It replaced
// direct links to the public `p` edge function: Supabase serves function
// responses on *.supabase.co with Content-Type text/plain (anti-phishing), so
// browsers displayed the raw HTML source instead of rendering it. Rendering
// here keeps the security model — the artifact HTML runs inside ArtifactFrame's
// opaque-origin sandbox, never on this origin where visitors hold a session.
export default function StandaloneArtifactPage() {
  const { slug } = useParams()
  const { status, artifact, error, submitting, submitPassword } = useSharedArtifact(slug)

  useEffect(() => {
    if (artifact?.title) document.title = artifact.title
  }, [artifact])

  if (status === 'loading') {
    return <div className="flex h-full items-center justify-center text-sm text-faint">Loading…</div>
  }

  if (status === 'missing') {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
        <p className="text-lg font-semibold text-text">This page isn’t available</p>
        <p className="text-sm text-muted">It may be private or the link is incorrect.</p>
        <Link to="/" className="text-sm font-medium text-primary hover:underline">
          Go to the intranet
        </Link>
      </div>
    )
  }

  if (status === 'password' || !artifact) {
    return (
      <div className="flex h-full items-center justify-center bg-surface">
        <ArtifactPasswordGate onSubmit={submitPassword} error={error} submitting={submitting} />
      </div>
    )
  }

  // Only HTML renders standalone — everything else has the framed share view.
  if (artifact.type !== 'html') {
    return <Navigate to={`/share/a/${slug}`} replace />
  }

  return (
    <ArtifactFrame
      title={artifact.title}
      content={artifact.content}
      data={artifact.data}
      // Persist interactions. RLS makes this a no-op for anyone but the owner.
      onSave={(data) => void supabase.from('artifacts').update({ data }).eq('id', artifact.id)}
      className="block h-dvh w-full bg-white"
    />
  )
}
