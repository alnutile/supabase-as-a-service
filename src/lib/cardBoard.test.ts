import { describe, expect, it } from 'vitest'
import {
  CANVAS_H,
  CANVAS_W,
  CARD_DEFAULT_H,
  CARD_DEFAULT_W,
  CARD_MAX_W,
  CARD_MIN_H,
  CARD_MIN_W,
  CARD_SIZES,
  cardFontSize,
  cardsSig,
  clampPosition,
  clampSize,
  normalizeCards,
  resizeTo,
  sizeLabel,
} from './cardBoard'

const color = (c: string) => (['yellow', 'pink', 'blue'].includes(c) ? c : 'yellow')

describe('clampSize', () => {
  it('defaults a missing size to the standard card', () => {
    expect(clampSize(undefined, undefined)).toEqual({ w: CARD_DEFAULT_W, h: CARD_DEFAULT_H })
    expect(clampSize('nope', null)).toEqual({ w: CARD_DEFAULT_W, h: CARD_DEFAULT_H })
  })
  it('clamps to the min/max bounds', () => {
    expect(clampSize(10, 10)).toEqual({ w: CARD_MIN_W, h: CARD_MIN_H })
    expect(clampSize(9999, 9999).w).toBe(CARD_MAX_W)
  })
  it('keeps a valid size (rounded)', () => {
    expect(clampSize(240.4, 160.6)).toEqual({ w: 240, h: 161 })
  })
})

describe('clampPosition', () => {
  it('keeps a card inside the canvas', () => {
    expect(clampPosition(-50, -50, 200, 120)).toEqual({ x: 0, y: 0 })
    const far = clampPosition(99999, 99999, 200, 120)
    expect(far).toEqual({ x: CANVAS_W - 200, y: CANVAS_H - 120 })
  })
  it('pulls a grown card back from the edge', () => {
    const { x } = clampPosition(CANVAS_W - 100, 10, 400, 120)
    expect(x).toBe(CANVAS_W - 400)
  })
})

describe('resizeTo', () => {
  it('adds the pointer delta to the starting size', () => {
    expect(resizeTo(190, 118, 60, 40, 100, 100)).toEqual({ w: 250, h: 158 })
  })
  it('never goes below the minimum', () => {
    expect(resizeTo(190, 118, -500, -500, 0, 0)).toEqual({ w: CARD_MIN_W, h: CARD_MIN_H })
  })
  it('never grows past the canvas edge', () => {
    const { w } = resizeTo(190, 118, 5000, 0, CANVAS_W - 200, 0)
    expect(w).toBe(200)
  })
})

describe('cardFontSize', () => {
  it('scales text with the card width', () => {
    expect(cardFontSize(CARD_DEFAULT_W)).toBe(13)
    expect(cardFontSize(360)).toBeGreaterThan(cardFontSize(CARD_DEFAULT_W))
    expect(cardFontSize(CARD_MIN_W)).toBeGreaterThanOrEqual(12)
    expect(cardFontSize(CARD_MAX_W)).toBeLessThanOrEqual(24)
  })
})

describe('sizeLabel', () => {
  it('names the closest preset', () => {
    expect(sizeLabel(CARD_SIZES.small.w, CARD_SIZES.small.h)).toBe('small')
    expect(sizeLabel(CARD_DEFAULT_W, CARD_DEFAULT_H)).toBe('medium')
    expect(sizeLabel(CARD_SIZES.huge.w + 4, CARD_SIZES.huge.h - 3)).toBe('huge')
  })
})

describe('normalizeCards', () => {
  it('fills size defaults for legacy cards (no w/h stored)', () => {
    const [c] = normalizeCards([{ id: 'a', text: 'old', color: 'pink', x: 10, y: 20 }], color)
    expect(c).toEqual({ id: 'a', text: 'old', color: 'pink', x: 10, y: 20, w: CARD_DEFAULT_W, h: CARD_DEFAULT_H })
  })
  it('keeps a stored size and drops garbage entries', () => {
    const cards = normalizeCards([null, 7, { id: 'b', text: 'big', w: 300, h: 200 }], color)
    expect(cards).toHaveLength(1)
    expect(cards[0].w).toBe(300)
    expect(cards[0].h).toBe(200)
    expect(cards[0].color).toBe('yellow')
  })
})

describe('cardsSig', () => {
  it('changes when a card is resized', () => {
    const base = normalizeCards([{ id: 'a', text: 'x', x: 0, y: 0 }], color)
    const bigger = normalizeCards([{ id: 'a', text: 'x', x: 0, y: 0, w: 300, h: 200 }], color)
    expect(cardsSig(base)).not.toBe(cardsSig(bigger))
    expect(cardsSig(base)).toBe(cardsSig(normalizeCards([{ id: 'a', text: 'x', x: 0, y: 0 }], color)))
  })
})
