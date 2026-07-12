// Pure, import-side-effect-free helpers for card boards — the free-form wall of
// movable cards (Planner). Kept out of builtins.ts so they can be unit-tested
// with `deno test` and reused by the collection-context loader.
//
//   * cardsToText(cards) → an AI-readable list of the cards, ordered
//     top-to-bottom by their y position (higher on the board = higher priority),
//     so "chat with this board" and get_card_board convey the ranking.
//   * normalizeCards / buildCards → turn the loose {text, color?} cards the
//     assistant writes into full {id, text, color, x, y} cards, auto-positioning
//     them in a tidy grid so add_cards / create_card_board can drop ideas onto a
//     board the user then drags to rank.

// deno-lint-ignore no-explicit-any
export type Card = Record<string, any>

export const CARD_COLORS = ['yellow', 'pink', 'green', 'blue', 'purple', 'gray'] as const

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
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}
function normColor(v: unknown): string {
  const c = String(v ?? '').trim().toLowerCase()
  return (CARD_COLORS as readonly string[]).includes(c) ? c : 'yellow'
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
    const tag = color === 'yellow' ? '' : `[${color}] `
    return `- ${tag}${String(c.text).trim().replace(/\s+/g, ' ')}`
  })
  return `${cards.length} card(s), ordered by priority (top of the board first):\n${lines.join('\n')}`
}

// ---------------------------------------------------------------------------
// normalizeCards — loose {text,color?,x?,y?} → full {id,text,color,x,y}.
// `startIndex` cascades auto-positions past cards already on the board.
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
    out.push({
      id: String(c.id ?? rid()),
      text,
      color: normColor(c.color),
      x: hasPos ? num(c.x, 0) : MARGIN + (i % COLS) * COL_W,
      y: hasPos ? num(c.y, 0) : MARGIN + Math.floor(i / COLS) * ROW_H,
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
