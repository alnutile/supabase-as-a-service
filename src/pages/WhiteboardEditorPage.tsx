import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Excalidraw, restoreElements } from '@excalidraw/excalidraw'
import '@excalidraw/excalidraw/index.css'
import type { Database } from '../lib/database.types'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import { ChevronLeftIcon, TrashIcon, UsersIcon } from '../components/icons'

type Whiteboard = Database['public']['Tables']['whiteboards']['Row']
// deno-lint-ignore no-explicit-any -- Excalidraw's element/api types are heavy; we
// stay loose on purpose (no-explicit-any is off in this project's eslint).
type Any = any

// Multiplayer whiteboard editor. The `whiteboards.scene` jsonb is the durable
// store (autosaved as people draw); on TOP of that we layer the first
// broadcast+presence Realtime channel in the app so edits and cursors sync live
// between everyone with the board open — the "used by others at the same time"
// experience. The DB subscription in the SAME channel also catches the
// assistant's update_whiteboard writes (which don't broadcast), so an AI drawing
// on the board renders live too. If broadcast ever drops, the debounced DB save +
// postgres_changes still keeps everyone eventually-consistent.

const CURSOR_COLORS = ['#e64980', '#7048e8', '#1c7ed6', '#0ca678', '#f08c00', '#e8590c', '#ae3ec9', '#2f9e44']
function colorFor(id: string): string {
  let h = 0
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return CURSOR_COLORS[h % CURSOR_COLORS.length]
}

// A stable signature of the drawn elements (id + Excalidraw's per-element
// version). Used to (a) skip no-op onChange fires (selection/pan don't bump
// versions) and (b) suppress the echo when we apply a remote scene.
function sceneSig(elements: readonly Any[]): string {
  return elements.map((e) => `${e.id}:${e.version ?? 0}`).join(',')
}

function useAppTheme(): 'light' | 'dark' {
  const read = () => (document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light')
  const [theme, setTheme] = useState<'light' | 'dark'>(read)
  useEffect(() => {
    const obs = new MutationObserver(() => setTheme(read()))
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => obs.disconnect()
  }, [])
  return theme
}

export default function WhiteboardEditorPage() {
  const { whiteboardId } = useParams()
  const navigate = useNavigate()
  const { user } = useAuth()
  const theme = useAppTheme()

  const [board, setBoard] = useState<Whiteboard | null>(null)
  const [notFound, setNotFound] = useState(false)
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved'>('idle')
  const [peers, setPeers] = useState(0)

  const apiRef = useRef<Any>(null)
  const channelRef = useRef<Any>(null)
  const collabRef = useRef<Map<string, Any>>(new Map())
  const lastSigRef = useRef<string>('')
  const suppressRef = useRef(false)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const bcastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const ptrTime = useRef(0)

  const myId = user?.id ?? 'anon'
  const myName = (user?.user_metadata?.name as string) || user?.email?.split('@')[0] || 'Someone'
  const myColor = useMemo(() => colorFor(myId), [myId])

  // Load the board once (Excalidraw reads initialData only at mount).
  useEffect(() => {
    if (!whiteboardId) return
    supabase
      .from('whiteboards')
      .select('*')
      .eq('id', whiteboardId)
      .single()
      .then(({ data }) => {
        if (data) setBoard(data)
        else setNotFound(true)
      })
  }, [whiteboardId])

  // Push a remote scene into the canvas without echoing it back out.
  const applyRemoteScene = useCallback((elements: Any[], files?: Any) => {
    const api = apiRef.current
    if (!api || !Array.isArray(elements)) return
    const restored = restoreElements(elements, null)
    lastSigRef.current = sceneSig(restored)
    suppressRef.current = true
    api.updateScene({ elements: restored })
    if (files && typeof files === 'object') {
      const arr = Object.values(files).filter(Boolean)
      if (arr.length) api.addFiles(arr as Any[])
    }
    setTimeout(() => (suppressRef.current = false), 60)
  }, [])

  // Live channel: broadcast (scene + cursors) + presence + the DB fallback.
  useEffect(() => {
    if (!whiteboardId || !board) return
    const channel = supabase.channel(`whiteboard:${whiteboardId}`, {
      config: { broadcast: { self: false }, presence: { key: myId } },
    })
    channelRef.current = channel

    channel
      .on('broadcast', { event: 'scene' }, ({ payload }: Any) => {
        if (payload?.from === myId) return
        applyRemoteScene(payload.elements, payload.files)
      })
      .on('broadcast', { event: 'pointer' }, ({ payload }: Any) => {
        if (!payload || payload.from === myId) return
        collabRef.current.set(payload.from, {
          pointer: { x: payload.x, y: payload.y },
          button: payload.button === 'down' ? 'down' : 'up',
          selectedElementIds: {},
          username: payload.name,
          color: { background: payload.color, stroke: payload.color },
        })
        apiRef.current?.updateScene({ collaborators: new Map(collabRef.current) })
      })
      .on('presence', { event: 'leave' }, ({ leftPresences }: Any) => {
        for (const p of leftPresences ?? []) {
          const key = p?.userId ?? p?.key
          if (key) collabRef.current.delete(key)
        }
        apiRef.current?.updateScene({ collaborators: new Map(collabRef.current) })
      })
      .on('presence', { event: 'sync' }, () => {
        const state = channel.presenceState() as Record<string, Any[]>
        // Count distinct people currently on the board (minus me).
        const others = Object.keys(state).filter((k) => k !== myId)
        setPeers(others.length)
      })
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'whiteboards', filter: `id=eq.${whiteboardId}` },
        ({ new: row }: Any) => {
          setBoard((b) => (b ? { ...b, title: row.title, visibility: row.visibility } : b))
          const els = row?.scene?.elements
          if (Array.isArray(els) && sceneSig(els) !== lastSigRef.current) {
            applyRemoteScene(els, row.scene?.files)
          }
        },
      )
      .subscribe((status: string) => {
        if (status === 'SUBSCRIBED') channel.track({ userId: myId, name: myName, color: myColor })
      })

    const collab = collabRef.current
    return () => {
      supabase.removeChannel(channel)
      channelRef.current = null
      collab.clear()
    }
    // Re-subscribe only when the board identity changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [whiteboardId, board?.id])

  // Persist the scene to Postgres (debounced) — the durable store.
  const persist = useCallback(
    (elements: Any[], appState: Any, files: Any) => {
      if (!whiteboardId) return
      clearTimeout(saveTimer.current)
      setSaveState('saving')
      saveTimer.current = setTimeout(async () => {
        const scene = {
          elements,
          appState: { viewBackgroundColor: appState?.viewBackgroundColor ?? '#ffffff' },
          files: files ?? {},
        }
        const { error } = await supabase.from('whiteboards').update({ scene }).eq('id', whiteboardId)
        setSaveState(error ? 'idle' : 'saved')
      }, 900)
    },
    [whiteboardId],
  )

  // Broadcast the scene to peers (debounced short, for low latency).
  const broadcast = useCallback(
    (elements: Any[], files: Any) => {
      clearTimeout(bcastTimer.current)
      bcastTimer.current = setTimeout(() => {
        channelRef.current?.send({
          type: 'broadcast',
          event: 'scene',
          payload: { from: myId, elements, files },
        })
      }, 120)
    },
    [myId],
  )

  const onChange = useCallback(
    (elements: readonly Any[], appState: Any, files: Any) => {
      if (suppressRef.current) return
      const sig = sceneSig(elements)
      if (sig === lastSigRef.current) return // selection/pan only — nothing drawn
      lastSigRef.current = sig
      const els = elements as Any[]
      broadcast(els, files)
      persist(els, appState, files)
    },
    [broadcast, persist],
  )

  const onPointerUpdate = useCallback(
    (payload: Any) => {
      const now = Date.now()
      if (now - ptrTime.current < 60) return // ~16 fps is plenty for cursors
      ptrTime.current = now
      const p = payload?.pointer
      if (!p) return
      channelRef.current?.send({
        type: 'broadcast',
        event: 'pointer',
        payload: { from: myId, x: p.x, y: p.y, button: payload.button, name: myName, color: myColor },
      })
    },
    [myId, myName, myColor],
  )

  async function rename(title: string) {
    setBoard((b) => (b ? { ...b, title } : b))
    if (whiteboardId) await supabase.from('whiteboards').update({ title }).eq('id', whiteboardId)
  }

  async function changeVisibility(visibility: Whiteboard['visibility']) {
    setBoard((b) => (b ? { ...b, visibility } : b))
    if (whiteboardId) await supabase.from('whiteboards').update({ visibility }).eq('id', whiteboardId)
  }

  async function remove() {
    if (!whiteboardId) return
    if (!confirm('Delete this whiteboard? This cannot be undone.')) return
    await supabase.from('whiteboards').delete().eq('id', whiteboardId)
    navigate('/whiteboards')
  }

  const initialData = useMemo(() => {
    if (!board) return null
    const scene = (board.scene ?? {}) as Any
    const els = Array.isArray(scene.elements) ? scene.elements : []
    lastSigRef.current = sceneSig(els)
    return {
      elements: els,
      appState: { viewBackgroundColor: scene.appState?.viewBackgroundColor ?? '#ffffff' },
      files: scene.files ?? undefined,
      scrollToContent: true,
    }
  }, [board])

  if (notFound) {
    return <div className="flex h-full items-center justify-center text-sm text-muted">Whiteboard not found.</div>
  }
  if (!board || !initialData) {
    return <div className="flex h-full items-center justify-center text-sm text-faint">Loading…</div>
  }

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-2 border-b border-border bg-surface px-4 py-2.5">
        <button
          onClick={() => navigate('/whiteboards')}
          title="Back to whiteboards"
          className="rounded-lg p-1.5 text-muted hover:bg-surface-hover hover:text-text"
        >
          <ChevronLeftIcon className="h-5 w-5" />
        </button>
        <input
          value={board.title}
          onChange={(e) => setBoard((b) => (b ? { ...b, title: e.target.value } : b))}
          onBlur={(e) => rename(e.target.value.trim() || 'Untitled whiteboard')}
          aria-label="Whiteboard title"
          className="min-w-0 flex-1 bg-transparent text-base font-semibold outline-none placeholder:text-faint"
          placeholder="Untitled whiteboard"
        />
        {peers > 0 && (
          <span
            className="flex items-center gap-1 rounded-full bg-primary-soft px-2.5 py-1 text-xs font-medium text-primary"
            title={`${peers} other ${peers === 1 ? 'person is' : 'people are'} editing`}
          >
            <UsersIcon className="h-3.5 w-3.5" /> {peers}
          </span>
        )}
        <span className="text-xs text-faint">
          {saveState === 'saving' ? 'Saving…' : saveState === 'saved' ? 'Saved' : ''}
        </span>
        <select
          value={board.visibility}
          onChange={(e) => changeVisibility(e.target.value as Whiteboard['visibility'])}
          className="rounded-md border border-border px-2 py-1 text-xs text-muted"
          title="Who can see and edit this board"
        >
          <option value="private">Private</option>
          <option value="workspace">Workspace</option>
        </select>
        <button
          onClick={remove}
          title="Delete"
          className="rounded-lg p-1.5 text-faint hover:bg-red-50 hover:text-red-600"
        >
          <TrashIcon className="h-[18px] w-[18px]" />
        </button>
      </div>

      {/* Canvas — Excalidraw fills the remaining space (needs a sized container). */}
      <div className="min-h-0 flex-1">
        <Excalidraw
          excalidrawAPI={(api: Any) => (apiRef.current = api)}
          initialData={initialData}
          onChange={onChange}
          onPointerUpdate={onPointerUpdate}
          isCollaborating={peers > 0}
          theme={theme}
        />
      </div>
    </div>
  )
}
