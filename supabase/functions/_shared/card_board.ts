// Pure, import-side-effect-free helpers for card boards — the free-form wall of
// movable cards (Planner). Kept out of builtins.ts so they can be unit-tested
// with `deno test` and reused by the collection-context loader.
//
//   * cardsToText(cards) → an AI-readable list of the cards, ordered
//     top-to-bottom by their y position (higher on the board = higher priority),
//     so "chat with this board" and get_card_board convey the ranking.
//   * normalizeCards / buildCards → turn the loose {text, color?, size?} cards
//     the assistant writes into full {id, text, color, x, y, w, h} cards,
//     auto-positioning them in a tidy grid so add_cards / create_card_board can
//     drop ideas onto a board the user then drags to rank (and resizes: a card's
//     size is its visual weight, kept on the same `cards` jsonb).

// deno-lint-ignore no-explicit-any
export type Card = Record<string, any>

export const CARD_COLORS = ['yellow', 'pink', 'green', 'blue', 'purple', 'gray'] as const

// Card sizes — the visual weight of an idea. The board UI resizes freely with a
// corner grip; these named presets are what a model can ask for.
export const CARD_SIZES: Record<string, { w: number; h: number }> = {
  small: { w: 150, h: 92 },
  medium: { w: 190, h: 118 },
  large: { w: 260, h: 168 },
  huge: { w: 360, h: 240 },
}
export const CARD_SIZE_NAMES = Object.keys(CARD_SIZES)
const DEFAULT_W = CARD_SIZES.medium.w
const DEFAULT_H = CARD_SIZES.medium.h
const MIN_W = 120
const MIN_H = 76
const MAX_W = 640
const MAX_H = 560

// Grid used when auto-placing cards the assistant adds (px).
const COL_W = 200
const ROW_H = 140
const MARGIN = 40
const COLS = 5

function rid(): string {
  try {
    return crypto.randomUUID()
  } catch {
    return 'c-' + Math.floor(Math.random() * 1e9).toString(36)
  }
}
function num(v: unknown, fallback: number): number {
  // null/'' coerce to 0 through Number(); treat anything but a real number as
  // absent so a missing size doesn't collapse to the minimum.
  if (v === null || v === undefined || v === '') return fallback
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}
function normColor(v: unknown): string {
  const c = String(v ?? '').trim().toLowerCase()
  return (CARD_COLORS as readonly string[]).includes(c) ? c : 'yellow'
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.round(Math.max(lo, Math.min(hi, v)))
}

// A card's size: an explicit {w,h}, a named `size` preset, or the default.
export function normSize(card: { w?: unknown; h?: unknown; size?: unknown }): { w: number; h: number } {
  const preset = CARD_SIZES[String(card?.size ?? '').trim().toLowerCase()]
  const w = card?.w !== undefined ? num(card.w, DEFAULT_W) : (preset?.w ?? DEFAULT_W)
  const h = card?.h !== undefined ? num(card.h, DEFAULT_H) : (preset?.h ?? DEFAULT_H)
  return { w: clamp(w, MIN_W, MAX_W), h: clamp(h, MIN_H, MAX_H) }
}

// The closest preset name for a size — how a size is described back to the model.
export function sizeLabel(w: unknown, h: unknown): string {
  const cw = num(w, DEFAULT_W)
  const ch = num(h, DEFAULT_H)
  let best = 'medium'
  let bestDist = Infinity
  for (const [name, s] of Object.entries(CARD_SIZES)) {
    const d = Math.abs(s.w - cw) + Math.abs(s.h - ch)
    if (d < bestDist) {
      bestDist = d
      best = name
    }
  }
  return best
}

export function cardsOf(board: unknown): Card[] {
  const b = board as { cards?: unknown } | null
  const cards = b?.cards
  return Array.isArray(cards) ? (cards as Card[]) : []
}

// ---------------------------------------------------------------------------
// cardsToText — describe a board's cards as a prioritized list.
// ---------------------------------------------------------------------------
export function cardsToText(board: unknown): string {
  const cards = cardsOf(board).filter((c) => c && typeof c.text === 'string' && c.text.trim())
  if (!cards.length) return '(empty board — no cards yet)'
  // Top-to-bottom, then left-to-right = reading order = priority order.
  const ordered = [...cards].sort((a, b) => num(a.y, 0) - num(b.y, 0) || num(a.x, 0) - num(b.x, 0))
  const lines = ordered.map((c) => {
    const color = normColor(c.color)
    // A resized card is a deliberate emphasis, so say so; a default-size yellow
    // card carries no tag at all (the common case stays terse).
    const { w, h } = normSize(c)
    const size = sizeLabel(w, h)
    const parts = [color === 'yellow' ? '' : color, size === 'medium' ? '' : size].filter(Boolean)
    const tag = parts.length ? `[${parts.join(', ')}] ` : ''
    return `- ${tag}${String(c.text).trim().replace(/\s+/g, ' ')}`
  })
  return `${cards.length} card(s), ordered by priority (top of the board first):\n${lines.join('\n')}`
}

// ---------------------------------------------------------------------------
// normalizeCards — loose {text,color?,size?,x?,y?,w?,h?} → full
// {id,text,color,x,y,w,h}. `startIndex` cascades auto-positions past cards
// already on the board.
// ---------------------------------------------------------------------------
export function normalizeCards(input: unknown, startIndex = 0): Card[] {
  if (!Array.isArray(input)) return []
  const out: Card[] = []
  let i = startIndex
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') continue
    const c = raw as Card
    const text = typeof c.text === 'string' ? c.text : ''
    if (!text.trim()) continue
    const hasPos = c.x !== undefined && c.y !== undefined
    const { w, h } = normSize(c)
    out.push({
      id: String(c.id ?? rid()),
      text,
      color: normColor(c.color),
      x: hasPos ? num(c.x, 0) : MARGIN + (i % COLS) * COL_W,
      y: hasPos ? num(c.y, 0) : MARGIN + Math.floor(i / COLS) * ROW_H,
      w,
      h,
    })
    if (!hasPos) i++
  }
  return out
}

// Build (or append to) a board's cards from assistant-supplied cards.
export function buildCards(existing: unknown, input: unknown, mode: 'replace' | 'append'): Card[] {
  const prev = mode === 'append' ? cardsOf(existing) : []
  const fresh = normalizeCards(input, prev.length)
  return [...prev, ...fresh]
}

export function cardCount(board: unknown): number {
  return cardsOf(board).filter((c) => c && typeof c.text === 'string' && c.text.trim()).length
}
