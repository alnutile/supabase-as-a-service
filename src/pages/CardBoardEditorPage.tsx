import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import type { Database } from '../lib/database.types'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import { ChatIcon, ChevronLeftIcon, CloseIcon, PlusIcon, TrashIcon, UsersIcon } from '../components/icons'
import { BoardChatPanel } from '../components/BoardChatPanel'
import {
  CANVAS_H,
  CANVAS_W,
  CARD_DEFAULT_H,
  CARD_DEFAULT_W,
  CARD_SIZES,
  CARD_SIZE_NAMES,
  type Card,
  cardFontSize,
  cardsSig,
  clampPosition,
  normalizeCards,
  resizeTo,
  sizeLabel,
} from '../lib/cardBoard'

type CardBoard = Database['public']['Tables']['card_boards']['Row']

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

function normColor(c: string): string {
  return COLORS[c] ? c : 'yellow'
}
function cardsOf(board: CardBoard | null): Card[] {
  return normalizeCards(board?.cards, normColor)
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
  const [sizeMenu, setSizeMenu] = useState<string | null>(null)
  const [chatOpen, setChatOpen] = useState(false)

  const canvasRef = useRef<HTMLDivElement>(null)
  const cardsRef = useRef<Card[]>([])
  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null)
  const lastSigRef = useRef<string>('')
  const draggingRef = useRef(false)
  const dragRef = useRef<{ id: string; dx: number; dy: number } | null>(null)
  const resizeRef = useRef<{ id: string; startX: number; startY: number; w: number; h: number } | null>(null)
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
        if (!draggingRef.current) applyRemote(normalizeCards(payload.cards, normColor))
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
      const pos = clampPosition(x, y, CARD_DEFAULT_W, CARD_DEFAULT_H)
      const card: Card = { id, text: '', color: 'yellow', ...pos, w: CARD_DEFAULT_W, h: CARD_DEFAULT_H }
      pushLocal([...cardsRef.current, card])
      setEditingId(id)
    },
    [pushLocal],
  )

  const onCanvasDoubleClick = (e: React.MouseEvent) => {
    if (e.target !== canvasRef.current) return
    const rect = canvasRef.current!.getBoundingClientRect()
    addCardAt(e.clientX - rect.left - CARD_DEFAULT_W / 2, e.clientY - rect.top - 16)
  }

  const closeMenus = () => {
    setColorMenu(null)
    setSizeMenu(null)
  }

  const editText = (id: string, text: string) =>
    pushLocal(cardsRef.current.map((c) => (c.id === id ? { ...c, text } : c)))
  const setColor = (id: string, color: string) => {
    pushLocal(cardsRef.current.map((c) => (c.id === id ? { ...c, color } : c)))
    setColorMenu(null)
  }
  // Preset sizes — one click for "make this one big"; the corner grip is the
  // free-form version. Position is re-clamped so a grown card stays on canvas.
  const setSize = (id: string, name: string) => {
    const preset = CARD_SIZES[name] ?? CARD_SIZES.medium
    pushLocal(
      cardsRef.current.map((c) =>
        c.id === id ? { ...c, ...preset, ...clampPosition(c.x, c.y, preset.w, preset.h) } : c,
      ),
    )
    setSizeMenu(null)
  }
  const removeCard = (id: string) => pushLocal(cardsRef.current.filter((c) => c.id !== id))

  // --- Drag -----------------------------------------------------------------
  const onDragMove = useCallback(
    (e: PointerEvent) => {
      const d = dragRef.current
      const canvas = canvasRef.current
      if (!d || !canvas) return
      const rect = canvas.getBoundingClientRect()
      const card = cardsRef.current.find((c) => c.id === d.id)
      if (!card) return
      const pos = clampPosition(e.clientX - rect.left - d.dx, e.clientY - rect.top - d.dy, card.w, card.h)
      pushLocal(cardsRef.current.map((c) => (c.id === d.id ? { ...c, ...pos } : c)))
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

  // --- Resize (bottom-right grip) -------------------------------------------
  const onResizeMove = useCallback(
    (e: PointerEvent) => {
      const r = resizeRef.current
      if (!r) return
      const card = cardsRef.current.find((c) => c.id === r.id)
      if (!card) return
      const size = resizeTo(r.w, r.h, e.clientX - r.startX, e.clientY - r.startY, card.x, card.y)
      if (size.w === card.w && size.h === card.h) return
      pushLocal(cardsRef.current.map((c) => (c.id === r.id ? { ...c, ...size } : c)))
    },
    [pushLocal],
  )
  const onResizeEnd = useCallback(() => {
    draggingRef.current = false
    resizeRef.current = null
    window.removeEventListener('pointermove', onResizeMove)
    window.removeEventListener('pointerup', onResizeEnd)
  }, [onResizeMove])
  const startResize = (e: React.PointerEvent, id: string) => {
    e.preventDefault()
    e.stopPropagation()
    const card = cardsRef.current.find((c) => c.id === id)
    if (!card) return
    resizeRef.current = { id, startX: e.clientX, startY: e.clientY, w: card.w, h: card.h }
    draggingRef.current = true
    window.addEventListener('pointermove', onResizeMove)
    window.addEventListener('pointerup', onResizeEnd)
  }

  useEffect(
    () => () => {
      window.removeEventListener('pointermove', onDragMove)
      window.removeEventListener('pointerup', onDragEnd)
      window.removeEventListener('pointermove', onResizeMove)
      window.removeEventListener('pointerup', onResizeEnd)
    },
    [onDragMove, onDragEnd, onResizeMove, onResizeEnd],
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
            const sx = el ? el.scrollLeft + el.clientWidth / 2 - CARD_DEFAULT_W / 2 : 60
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
          onClick={closeMenus}
          style={{ width: CANVAS_W, height: CANVAS_H, ...dotBg }}
          className="relative"
        >
          {cards.length === 0 && (
            <div className="pointer-events-none absolute left-1/2 top-24 -translate-x-1/2 text-center text-sm text-faint">
              Double-click anywhere to add a card. Drag the top bar to move it, drag the bottom-right corner to
              resize it; arrange top-to-bottom by priority.
            </div>
          )}
          {cards.map((c) => {
            const col = COLORS[c.color] ?? COLORS.yellow
            const active = sizeLabel(c.w, c.h)
            return (
              <div
                key={c.id}
                style={{ left: c.x, top: c.y, width: c.w, height: c.h, background: col.bg }}
                className="absolute flex flex-col rounded-lg shadow-md ring-1 ring-black/5"
              >
                {/* Drag handle / color / size / delete */}
                <div
                  onPointerDown={(e) => startDrag(e, c.id)}
                  style={{ background: col.bar }}
                  className="flex shrink-0 cursor-grab items-center justify-between gap-1 rounded-t-lg px-1.5 py-1 active:cursor-grabbing"
                >
                  <div className="flex items-center gap-1">
                    <div className="relative">
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          setSizeMenu(null)
                          setColorMenu((m) => (m === c.id ? null : c.id))
                        }}
                        onPointerDown={(e) => e.stopPropagation()}
                        title="Change color"
                        className="block h-4 w-4 rounded-full border border-black/20"
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
                    <div className="relative">
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          setColorMenu(null)
                          setSizeMenu((m) => (m === c.id ? null : c.id))
                        }}
                        onPointerDown={(e) => e.stopPropagation()}
                        title="Card size — or drag the bottom-right corner"
                        aria-label="Card size"
                        className="flex h-4 items-center rounded border border-black/20 px-1 text-[9px] font-bold uppercase leading-none text-black/50 hover:text-black/80"
                      >
                        {active === 'huge' ? 'XL' : active.charAt(0).toUpperCase()}
                      </button>
                      {sizeMenu === c.id && (
                        <div
                          onPointerDown={(e) => e.stopPropagation()}
                          className="absolute left-0 top-6 z-20 flex gap-1 rounded-lg border border-border bg-surface p-1.5 shadow-xl"
                        >
                          {CARD_SIZE_NAMES.map((name) => (
                            <button
                              key={name}
                              onClick={(e) => {
                                e.stopPropagation()
                                setSize(c.id, name)
                              }}
                              title={name}
                              className={`rounded px-1.5 py-0.5 text-[11px] font-medium capitalize ${
                                active === name ? 'bg-primary-soft text-primary' : 'text-muted hover:bg-surface-hover'
                              }`}
                            >
                              {name}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
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
                  style={{ fontSize: cardFontSize(c.w) }}
                  className="min-h-0 w-full flex-1 resize-none rounded-b-lg bg-transparent px-2.5 py-2 leading-snug text-slate-800 outline-none placeholder:text-slate-500"
                />
                {/* Resize grip — free-form sizing; size is the visual weight of an idea */}
                <div
                  onPointerDown={(e) => startResize(e, c.id)}
                  onClick={(e) => e.stopPropagation()}
                  onDoubleClick={(e) => e.stopPropagation()}
                  role="separator"
                  aria-label="Resize card"
                  title="Drag to resize"
                  className="absolute bottom-0 right-0 h-4 w-4 cursor-nwse-resize touch-none rounded-br-lg text-black/30 hover:text-black/60"
                >
                  <svg viewBox="0 0 16 16" className="h-4 w-4" aria-hidden="true">
                    <path d="M15 8 L8 15 M15 12 L12 15" stroke="currentColor" strokeWidth="1.5" fill="none" />
                  </svg>
                </div>
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
