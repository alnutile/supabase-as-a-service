// Pure geometry + normalization for the Cards board (Planner). Kept out of
// CardBoardEditorPage so the sizing maths is unit-testable.
//
// A card is a sticky note on a free-form wall: its POSITION is the priority
// ranking and its SIZE is the visual weight — a big card reads as a big idea.
// Both live on the `cards` jsonb, so resizing needs no schema change.

export type Card = {
  id: string
  text: string
  color: string
  x: number
  y: number
  w: number
  h: number
}

export const CARD_DEFAULT_W = 190
export const CARD_DEFAULT_H = 118
export const CARD_MIN_W = 120
export const CARD_MIN_H = 76
export const CARD_MAX_W = 640
export const CARD_MAX_H = 560

export const CANVAS_W = 2600
export const CANVAS_H = 1700

// Named presets, so a card can be resized in one click (and so the assistant
// can ask for a "large" card without knowing pixels).
export const CARD_SIZES: Record<string, { w: number; h: number }> = {
  small: { w: 150, h: 92 },
  medium: { w: CARD_DEFAULT_W, h: CARD_DEFAULT_H },
  large: { w: 260, h: 168 },
  huge: { w: 360, h: 240 },
}
export const CARD_SIZE_NAMES = Object.keys(CARD_SIZES)

function num(v: unknown, fallback: number): number {
  // Note null/'' coerce to 0 through Number(), which would silently collapse a
  // missing size to the minimum — treat anything but a real number as absent.
  if (v === null || v === undefined || v === '') return fallback
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

export function clampSize(w: unknown, h: unknown): { w: number; h: number } {
  return {
    w: Math.round(Math.max(CARD_MIN_W, Math.min(CARD_MAX_W, num(w, CARD_DEFAULT_W)))),
    h: Math.round(Math.max(CARD_MIN_H, Math.min(CARD_MAX_H, num(h, CARD_DEFAULT_H)))),
  }
}

// Keep a card inside the canvas. A card that grew past the right/bottom edge is
// pulled back rather than clipped.
export function clampPosition(x: unknown, y: unknown, w: number, h: number): { x: number; y: number } {
  return {
    x: Math.round(Math.max(0, Math.min(CANVAS_W - w, num(x, 40)))),
    y: Math.round(Math.max(0, Math.min(CANVAS_H - h, num(y, 40)))),
  }
}

// Text scales with the card, so size is legible at a glance and not just a
// bigger empty rectangle.
export function cardFontSize(w: number): number {
  return Math.max(12, Math.min(24, Math.round(13 + (num(w, CARD_DEFAULT_W) - CARD_DEFAULT_W) / 26)))
}

// The closest preset name for a size — used for the size menu's active state.
export function sizeLabel(w: number, h: number): string {
  let best = 'medium'
  let bestDist = Infinity
  for (const [name, s] of Object.entries(CARD_SIZES)) {
    const d = Math.abs(s.w - w) + Math.abs(s.h - h)
    if (d < bestDist) {
      bestDist = d
      best = name
    }
  }
  return best
}

// Resize from the bottom-right grip: start size + pointer delta, clamped to the
// size limits AND to what fits on the canvas from the card's own position.
export function resizeTo(
  startW: number,
  startH: number,
  dx: number,
  dy: number,
  x: number,
  y: number,
): { w: number; h: number } {
  const { w, h } = clampSize(startW + dx, startH + dy)
  return {
    w: Math.max(CARD_MIN_W, Math.min(w, CANVAS_W - x)),
    h: Math.max(CARD_MIN_H, Math.min(h, CANVAS_H - y)),
  }
}

export function normalizeCard(raw: unknown, fallbackColor: (c: string) => string): Card {
  const o = (raw ?? {}) as Record<string, unknown>
  const { w, h } = clampSize(o.w, o.h)
  const { x, y } = clampPosition(o.x, o.y, w, h)
  return {
    id: String(o.id ?? crypto.randomUUID()),
    text: typeof o.text === 'string' ? o.text : '',
    color: fallbackColor(String(o.color ?? 'yellow')),
    x,
    y,
    w,
    h,
  }
}

export function normalizeCards(raw: unknown, fallbackColor: (c: string) => string): Card[] {
  const list = Array.isArray(raw) ? (raw as unknown[]) : []
  return list.filter((c) => !!c && typeof c === 'object').map((c) => normalizeCard(c, fallbackColor))
}

// Signature used to suppress our own realtime echo — size is part of it, so a
// peer's resize is applied instead of being mistaken for our own state.
export function cardsSig(cards: Card[]): string {
  return cards
    .map((c) => `${c.id}:${Math.round(c.x)}:${Math.round(c.y)}:${Math.round(c.w)}:${Math.round(c.h)}:${c.color}:${c.text}`)
    .join('|')
}
