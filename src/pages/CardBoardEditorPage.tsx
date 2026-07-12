import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import type { Database } from '../lib/database.types'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import { ChatIcon, ChevronLeftIcon, CloseIcon, PlusIcon, TrashIcon, UsersIcon } from '../components/icons'
import { BoardChatPanel } from '../components/BoardChatPanel'

type CardBoard = Database['public']['Tables']['card_boards']['Row']
type Card = { id: string; text: string; color: string; x: number; y: number }

// Sticky-note palette — solid pastels with dark text, so cards read the same in
// light and dark mode (a sticky note is a physical object, not themed chrome).
const COLORS: Record<string, { bg: string; bar: string }> = {
  yellow: { bg: '#fef9c3', bar: '#fde047' },
  pink: { bg: '#fbcfe8', bar: '#f9a8d4' },
  green: { bg: '#bbf7d0', bar: '#86efac' },
  blue: { bg: '#bfdbfe', bar: '#93c5fd' },
  purple: { bg: '#e9d5ff', bar: '#d8b4fe' },
  gray: { bg: '#e5e7eb', bar: '#d1d5db' },
}
const COLOR_NAMES = Object.keys(COLORS)
const CARD_W = 190
const CANVAS_W = 2600
const CANVAS_H = 1700

function normColor(c: string): string {
  return COLORS[c] ? c : 'yellow'
}
function cardsOf(board: CardBoard | null): Card[] {
  const raw = Array.isArray(board?.cards) ? (board!.cards as unknown[]) : []
  return raw
    .filter((c): c is Card => !!c && typeof c === 'object')
    .map((c) => {
      const o = c as Record<string, unknown>
      return {
        id: String(o.id ?? crypto.randomUUID()),
        text: typeof o.text === 'string' ? o.text : '',
        color: normColor(String(o.color ?? 'yellow')),
        x: Number.isFinite(Number(o.x)) ? Number(o.x) : 40,
        y: Number.isFinite(Number(o.y)) ? Number(o.y) : 40,
      }
    })
}
function cardsSig(cards: Card[]): string {
  return cards.map((c) => `${c.id}:${Math.round(c.x)}:${Math.round(c.y)}:${c.color}:${c.text}`).join('|')
}

export default function CardBoardEditorPage() {
  const { boardId } = useParams()
  const navigate = useNavigate()
  const { user } = useAuth()

  const [board, setBoard] = useState<CardBoard | null>(null)
  const [notFound, setNotFound] = useState(false)
  const [cards, setCards] = useState<Card[]>([])
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved'>('idle')
  const [peers, setPeers] = useState(0)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [colorMenu, setColorMenu] = useState<string | null>(null)
  const [chatOpen, setChatOpen] = useState(false)

  const canvasRef = useRef<HTMLDivElement>(null)
  const cardsRef = useRef<Card[]>([])
  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null)
  const lastSigRef = useRef<string>('')
  const draggingRef = useRef(false)
  const dragRef = useRef<{ id: string; dx: number; dy: number } | null>(null)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const bcastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const myId = user?.id ?? 'anon'

  useEffect(() => {
    cardsRef.current = cards
  }, [cards])

  // Load once.
  useEffect(() => {
    if (!boardId) return
    supabase
      .from('card_boards')
      .select('*')
      .eq('id', boardId)
      .single()
      .then(({ data }) => {
        if (data) {
          setBoard(data)
          const cs = cardsOf(data)
          cardsRef.current = cs
          setCards(cs)
          lastSigRef.current = cardsSig(cs)
        } else setNotFound(true)
      })
  }, [boardId])

  const scheduleSave = useCallback(
    (next: Card[]) => {
      if (!boardId) return
      clearTimeout(saveTimer.current)
      setSaveState('saving')
      saveTimer.current = setTimeout(async () => {
        const { error } = await supabase.from('card_boards').update({ cards: next }).eq('id', boardId)
        setSaveState(error ? 'idle' : 'saved')
      }, 700)
    },
    [boardId],
  )

  const scheduleBroadcast = useCallback(
    (next: Card[]) => {
      clearTimeout(bcastTimer.current)
      bcastTimer.current = setTimeout(() => {
        channelRef.current?.send({ type: 'broadcast', event: 'cards', payload: { from: myId, cards: next } })
      }, 120)
    },
    [myId],
  )

  // Single mutation path for local changes: update state, broadcast, save.
  const pushLocal = useCallback(
    (next: Card[]) => {
      cardsRef.current = next
      setCards(next)
      lastSigRef.current = cardsSig(next)
      scheduleBroadcast(next)
      scheduleSave(next)
    },
    [scheduleBroadcast, scheduleSave],
  )

  // Remote change (peer broadcast, AI update, other device): apply WITHOUT
  // re-broadcasting. lastSig set to the remote sig so our own echo is a no-op.
  const applyRemote = useCallback((next: Card[]) => {
    cardsRef.current = next
    setCards(next)
    lastSigRef.current = cardsSig(next)
  }, [])

  // Live channel: broadcast card changes + presence + DB fallback.
  useEffect(() => {
    if (!boardId || !board) return
    const channel = supabase.channel(`card_board:${boardId}`, {
      config: { broadcast: { self: false }, presence: { key: myId } },
    })
    channelRef.current = channel
    channel
      .on('broadcast', { event: 'cards' }, ({ payload }) => {
        if (!payload || payload.from === myId) return
        if (!draggingRef.current) applyRemote(cardsOf({ cards: payload.cards } as CardBoard))
      })
      .on('presence', { event: 'sync' }, () => {
        const state = channel.presenceState() as Record<string, unknown[]>
        setPeers(Object.keys(state).filter((k) => k !== myId).length)
      })
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'card_boards', filter: `id=eq.${boardId}` },
        ({ new: row }) => {
          const r = row as CardBoard
          setBoard((b) => (b ? { ...b, title: r.title, visibility: r.visibility } : b))
          const next = cardsOf(r)
          if (!draggingRef.current && cardsSig(next) !== lastSigRef.current) applyRemote(next)
        },
      )
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') channel.track({ userId: myId })
      })
    return () => {
      supabase.removeChannel(channel)
      channelRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boardId, board?.id])

  // --- Card mutations -------------------------------------------------------
  const addCardAt = useCallback(
    (x: number, y: number) => {
      const id = crypto.randomUUID()
      const card: Card = { id, text: '', color: 'yellow', x: Math.max(0, x), y: Math.max(0, y) }
      pushLocal([...cardsRef.current, card])
      setEditingId(id)
    },
    [pushLocal],
  )

  const onCanvasDoubleClick = (e: React.MouseEvent) => {
    if (e.target !== canvasRef.current) return
    const rect = canvasRef.current!.getBoundingClientRect()
    addCardAt(e.clientX - rect.left - CARD_W / 2, e.clientY - rect.top - 16)
  }

  const editText = (id: string, text: string) =>
    pushLocal(cardsRef.current.map((c) => (c.id === id ? { ...c, text } : c)))
  const setColor = (id: string, color: string) => {
    pushLocal(cardsRef.current.map((c) => (c.id === id ? { ...c, color } : c)))
    setColorMenu(null)
  }
  const removeCard = (id: string) => pushLocal(cardsRef.current.filter((c) => c.id !== id))

  // --- Drag -----------------------------------------------------------------
  const onDragMove = useCallback(
    (e: PointerEvent) => {
      const d = dragRef.current
      const canvas = canvasRef.current
      if (!d || !canvas) return
      const rect = canvas.getBoundingClientRect()
      const x = Math.max(0, Math.min(CANVAS_W - CARD_W, e.clientX - rect.left - d.dx))
      const y = Math.max(0, Math.min(CANVAS_H - 40, e.clientY - rect.top - d.dy))
      pushLocal(cardsRef.current.map((c) => (c.id === d.id ? { ...c, x, y } : c)))
    },
    [pushLocal],
  )
  const onDragEnd = useCallback(() => {
    draggingRef.current = false
    dragRef.current = null
    window.removeEventListener('pointermove', onDragMove)
    window.removeEventListener('pointerup', onDragEnd)
  }, [onDragMove])
  const startDrag = (e: React.PointerEvent, id: string) => {
    e.preventDefault()
    const canvas = canvasRef.current
    const card = cardsRef.current.find((c) => c.id === id)
    if (!canvas || !card) return
    const rect = canvas.getBoundingClientRect()
    dragRef.current = { id, dx: e.clientX - rect.left - card.x, dy: e.clientY - rect.top - card.y }
    draggingRef.current = true
    window.addEventListener('pointermove', onDragMove)
    window.addEventListener('pointerup', onDragEnd)
  }
  useEffect(
    () => () => {
      window.removeEventListener('pointermove', onDragMove)
      window.removeEventListener('pointerup', onDragEnd)
    },
    [onDragMove, onDragEnd],
  )

  // --- Board-level actions --------------------------------------------------
  async function rename(title: string) {
    setBoard((b) => (b ? { ...b, title } : b))
    if (boardId) await supabase.from('card_boards').update({ title }).eq('id', boardId)
  }
  async function changeVisibility(visibility: CardBoard['visibility']) {
    setBoard((b) => (b ? { ...b, visibility } : b))
    if (boardId) await supabase.from('card_boards').update({ visibility }).eq('id', boardId)
  }
  async function removeBoard() {
    if (!boardId) return
    if (!confirm('Delete this board? This cannot be undone.')) return
    await supabase.from('card_boards').delete().eq('id', boardId)
    navigate('/cards')
  }

  const dotBg = useMemo(
    () => ({
      backgroundImage: 'radial-gradient(var(--color-border) 1px, transparent 1px)',
      backgroundSize: '22px 22px',
    }),
    [],
  )

  if (notFound) return <div className="flex h-full items-center justify-center text-sm text-muted">Board not found.</div>
  if (!board) return <div className="flex h-full items-center justify-center text-sm text-faint">Loading…</div>

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-2 border-b border-border bg-surface px-4 py-2.5">
        <button
          onClick={() => navigate('/cards')}
          title="Back to boards"
          className="rounded-lg p-1.5 text-muted hover:bg-surface-hover hover:text-text"
        >
          <ChevronLeftIcon className="h-5 w-5" />
        </button>
        <input
          value={board.title}
          onChange={(e) => setBoard((b) => (b ? { ...b, title: e.target.value } : b))}
          onBlur={(e) => rename(e.target.value.trim() || 'Untitled board')}
          aria-label="Board title"
          className="min-w-0 flex-1 bg-transparent text-base font-semibold outline-none placeholder:text-faint"
          placeholder="Untitled board"
        />
        <button
          onClick={() => {
            const el = canvasRef.current
            const sx = el ? el.scrollLeft + el.clientWidth / 2 - CARD_W / 2 : 60
            const sy = el ? el.scrollTop + 80 : 60
            addCardAt(sx, sy)
          }}
          className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-muted transition hover:border-primary hover:text-primary"
        >
          <PlusIcon className="h-4 w-4" /> Card
        </button>
        <button
          onClick={() => setChatOpen((v) => !v)}
          title="Chat about these cards — the assistant reads the board and can add cards; history is saved"
          className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm font-medium transition ${
            chatOpen ? 'border-primary bg-primary-soft text-primary' : 'border-border text-muted hover:border-primary hover:text-primary'
          }`}
        >
          <ChatIcon className="h-4 w-4" /> Chat
        </button>
        {peers > 0 && (
          <span
            className="flex items-center gap-1 rounded-full bg-primary-soft px-2.5 py-1 text-xs font-medium text-primary"
            title={`${peers} other ${peers === 1 ? 'person is' : 'people are'} here`}
          >
            <UsersIcon className="h-3.5 w-3.5" /> {peers}
          </span>
        )}
        <span className="w-12 text-xs text-faint">
          {saveState === 'saving' ? 'Saving…' : saveState === 'saved' ? 'Saved' : ''}
        </span>
        <select
          value={board.visibility}
          onChange={(e) => changeVisibility(e.target.value as CardBoard['visibility'])}
          className="rounded-md border border-border px-2 py-1 text-xs text-muted"
          title="Who can see and edit this board"
        >
          <option value="private">Private</option>
          <option value="workspace">Workspace</option>
        </select>
        <button onClick={removeBoard} title="Delete board" className="rounded-lg p-1.5 text-faint hover:bg-red-50 hover:text-red-600">
          <TrashIcon className="h-[18px] w-[18px]" />
        </button>
      </div>

      {/* Canvas + optional chat panel */}
      <div className="relative flex min-h-0 flex-1">
      {/* Canvas — scrollable; double-click empty space to add a card */}
      <div className="min-h-0 flex-1 overflow-auto bg-surface-2">
        <div
          ref={canvasRef}
          onDoubleClick={onCanvasDoubleClick}
          onClick={() => setColorMenu(null)}
          style={{ width: CANVAS_W, height: CANVAS_H, ...dotBg }}
          className="relative"
        >
          {cards.length === 0 && (
            <div className="pointer-events-none absolute left-1/2 top-24 -translate-x-1/2 text-center text-sm text-faint">
              Double-click anywhere to add a card. Drag the top bar to move it; arrange top-to-bottom by priority.
            </div>
          )}
          {cards.map((c) => {
            const col = COLORS[c.color] ?? COLORS.yellow
            return (
              <div
                key={c.id}
                style={{ left: c.x, top: c.y, width: CARD_W, background: col.bg }}
                className="absolute rounded-lg shadow-md ring-1 ring-black/5"
              >
                {/* Drag handle / color / delete */}
                <div
                  onPointerDown={(e) => startDrag(e, c.id)}
                  style={{ background: col.bar }}
                  className="flex cursor-grab items-center justify-between rounded-t-lg px-1.5 py-1 active:cursor-grabbing"
                >
                  <div className="relative">
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        setColorMenu((m) => (m === c.id ? null : c.id))
                      }}
                      onPointerDown={(e) => e.stopPropagation()}
                      title="Change color"
                      className="h-4 w-4 rounded-full border border-black/20"
                      style={{ background: col.bg }}
                    />
                    {colorMenu === c.id && (
                      <div
                        onPointerDown={(e) => e.stopPropagation()}
                        className="absolute left-0 top-6 z-20 flex gap-1 rounded-lg border border-border bg-surface p-1.5 shadow-xl"
                      >
                        {COLOR_NAMES.map((name) => (
                          <button
                            key={name}
                            onClick={(e) => {
                              e.stopPropagation()
                              setColor(c.id, name)
                            }}
                            title={name}
                            className="h-5 w-5 rounded-full border border-black/20"
                            style={{ background: COLORS[name].bg }}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      removeCard(c.id)
                    }}
                    onPointerDown={(e) => e.stopPropagation()}
                    title="Delete card"
                    className="rounded p-0.5 text-black/40 hover:bg-black/10 hover:text-black/70"
                  >
                    <CloseIcon className="h-3.5 w-3.5" />
                  </button>
                </div>
                <textarea
                  value={c.text}
                  autoFocus={editingId === c.id}
                  onChange={(e) => editText(c.id, e.target.value)}
                  onFocus={() => setEditingId(c.id)}
                  onBlur={() => setEditingId((id) => (id === c.id ? null : id))}
                  placeholder="Write an idea…"
                  spellCheck={false}
                  rows={3}
                  className="w-full resize-none rounded-b-lg bg-transparent px-2.5 py-2 text-sm text-slate-800 outline-none placeholder:text-slate-500"
                />
              </div>
            )
          })}
        </div>
      </div>
        {chatOpen && boardId && (
          <div className="absolute inset-0 z-30 md:static md:z-auto md:w-96 md:shrink-0">
            <BoardChatPanel boardId={boardId} boardTitle={board.title} onClose={() => setChatOpen(false)} />
          </div>
        )}
      </div>
    </div>
  )
}
