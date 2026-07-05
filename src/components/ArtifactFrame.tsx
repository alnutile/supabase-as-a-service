import { useCallback, useEffect, useRef } from 'react'
import type { Json } from '../lib/database.types'

// Sandboxed renderer for `html` artifacts + the postMessage bridge that makes
// them interactive AND persistent. The iframe keeps `allow-scripts` without
// `allow-same-origin` (opaque origin — no cookies, no Supabase session, no
// parent DOM), which also means the artifact's JS can't reach localStorage or
// the database itself. So state flows over a tiny protocol instead:
//
//   iframe → parent  { type: 'artifact:ready' }              "send me my state"
//   parent → iframe  { type: 'artifact:state', data }         saved artifacts.data
//   iframe → parent  { type: 'artifact:save',  data }         "persist this"
//
// The PARENT owns persistence (it holds the authed client and writes under
// normal RLS) via the onSave prop; the artifact HTML never sees credentials.
// Saves are debounced here so a fast run of clicks is one UPDATE, and flushed
// on unmount so the last change isn't lost.
export function ArtifactFrame({
  content,
  data,
  onSave,
  className,
  title = 'artifact',
}: {
  content: string
  data?: Json
  onSave?: (data: Json) => void | Promise<void>
  className?: string
  title?: string
}) {
  const frameRef = useRef<HTMLIFrameElement>(null)
  // Last state either side has seen, as JSON — used to skip echo re-sends
  // (our own save comes back via realtime as a `data` prop change).
  const lastSent = useRef<string>(JSON.stringify(data ?? {}))
  const pending = useRef<Json | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const onSaveRef = useRef(onSave)
  onSaveRef.current = onSave

  const postState = useCallback(() => {
    frameRef.current?.contentWindow?.postMessage(
      // Opaque origin means the frame's origin is 'null' — '*' is required.
      { type: 'artifact:state', data: JSON.parse(lastSent.current) },
      '*',
    )
  }, [])

  const flush = useCallback(() => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    if (pending.current !== null) {
      onSaveRef.current?.(pending.current)
      pending.current = null
    }
  }, [])

  useEffect(() => {
    function onMessage(e: MessageEvent) {
      // Only trust messages from OUR iframe (other frames/extensions post too).
      if (!frameRef.current || e.source !== frameRef.current.contentWindow) return
      const msg = e.data as { type?: string; data?: Json } | null
      if (msg?.type === 'artifact:ready') {
        postState()
      } else if (msg?.type === 'artifact:save') {
        const next = msg.data ?? {}
        lastSent.current = JSON.stringify(next)
        pending.current = next
        if (timer.current) clearTimeout(timer.current)
        timer.current = setTimeout(flush, 500)
      }
    }
    window.addEventListener('message', onMessage)
    return () => {
      window.removeEventListener('message', onMessage)
      flush()
    }
  }, [postState, flush])

  // External state change (realtime from another device / the assistant) —
  // push it into the frame unless it's just our own save echoing back.
  useEffect(() => {
    const next = JSON.stringify(data ?? {})
    if (next !== lastSent.current) {
      lastSent.current = next
      postState()
    }
  }, [data, postState])

  return (
    <iframe
      ref={frameRef}
      title={title}
      sandbox="allow-scripts"
      srcDoc={content}
      className={className}
      // The frame reloads whenever `content` changes (new srcDoc), so re-send
      // state on load too — belt and braces alongside the ready handshake.
      onLoad={postState}
    />
  )
}
