// deno test — the pure card-board helpers (cardsToText / normalizeCards /
// buildCards). Kept pure so the DB side of the card-board builtins needs no mocks.
import { assertEquals, assertStringIncludes } from 'jsr:@std/assert@1'
import { buildCards, cardCount, cardsToText, normalizeCards, normSize, sizeLabel } from '../_shared/card_board.ts'

Deno.test('cardsToText: empty → placeholder', () => {
  assertEquals(cardsToText({}), '(empty board — no cards yet)')
  assertEquals(cardsToText(null), '(empty board — no cards yet)')
  assertEquals(cardsToText({ cards: [] }), '(empty board — no cards yet)')
})

Deno.test('cardsToText: lists cards top-to-bottom (priority order)', () => {
  const board = {
    cards: [
      { id: 'a', text: 'Lower priority', x: 0, y: 300 },
      { id: 'b', text: 'Top priority', x: 0, y: 10 },
    ],
  }
  const out = cardsToText(board)
  const top = out.indexOf('Top priority')
  const low = out.indexOf('Lower priority')
  assertEquals(top < low, true)
  assertStringIncludes(out, '2 card(s)')
})

Deno.test('cardsToText: shows non-default color tag', () => {
  const out = cardsToText({ cards: [{ text: 'Urgent', color: 'red-not-valid' }, { text: 'Hot', color: 'pink' }] })
  assertStringIncludes(out, '[pink] Hot')
  // invalid color falls back to yellow → no tag
  assertStringIncludes(out, '- Urgent')
})

Deno.test('cardsToText: skips blank cards', () => {
  assertEquals(cardsToText({ cards: [{ text: '   ' }, { text: '' }] }), '(empty board — no cards yet)')
})

Deno.test('normalizeCards: fills id/color and auto-positions in a grid', () => {
  const cards = normalizeCards([{ text: 'one' }, { text: 'two' }])
  assertEquals(cards.length, 2)
  assertEquals(typeof cards[0].id, 'string')
  assertEquals(cards[0].color, 'yellow')
  // different auto positions
  assertEquals(cards[0].x !== cards[1].x || cards[0].y !== cards[1].y, true)
})

Deno.test('normalizeCards: honours explicit x/y and valid color', () => {
  const [c] = normalizeCards([{ text: 'placed', x: 123, y: 456, color: 'blue' }])
  assertEquals(c.x, 123)
  assertEquals(c.y, 456)
  assertEquals(c.color, 'blue')
})

Deno.test('normalizeCards: ignores garbage and blank text', () => {
  assertEquals(normalizeCards([null, 5, {}, { text: '  ' }]).length, 0)
  assertEquals(normalizeCards('nope' as unknown).length, 0)
})

Deno.test('normalizeCards: startIndex cascades positions past existing cards', () => {
  const a = normalizeCards([{ text: 'x' }], 0)
  const b = normalizeCards([{ text: 'y' }], 5)
  assertEquals(a[0].x === b[0].x && a[0].y === b[0].y, false)
})

Deno.test('buildCards: replace vs append', () => {
  const first = buildCards({}, [{ text: 'a' }], 'replace')
  assertEquals(cardCount({ cards: first }), 1)
  const appended = buildCards({ cards: first }, [{ text: 'b' }], 'append')
  assertEquals(cardCount({ cards: appended }), 2)
  const replaced = buildCards({ cards: first }, [{ text: 'b' }], 'replace')
  assertEquals(cardCount({ cards: replaced }), 1)
})

Deno.test('normSize: default, named preset, explicit and clamped', () => {
  assertEquals(normSize({}), { w: 190, h: 118 })
  assertEquals(normSize({ size: 'large' }), { w: 260, h: 168 })
  assertEquals(normSize({ size: 'NOPE' }), { w: 190, h: 118 })
  assertEquals(normSize({ w: 300, h: 200 }), { w: 300, h: 200 })
  // out-of-range sizes are clamped, not trusted
  assertEquals(normSize({ w: 5, h: 5 }), { w: 120, h: 76 })
  assertEquals(normSize({ w: 9999, h: 9999 }), { w: 640, h: 560 })
})

Deno.test('sizeLabel: names the closest preset', () => {
  assertEquals(sizeLabel(150, 92), 'small')
  assertEquals(sizeLabel(undefined, undefined), 'medium')
  assertEquals(sizeLabel(365, 236), 'huge')
})

Deno.test('normalizeCards: carries size (named or explicit), defaults the rest', () => {
  const cards = normalizeCards([{ text: 'big idea', size: 'huge' }, { text: 'plain' }, { text: 'exact', w: 300, h: 210 }])
  assertEquals(cards[0].w, 360)
  assertEquals(cards[0].h, 240)
  assertEquals(cards[1].w, 190)
  assertEquals(cards[2].w, 300)
  assertEquals(cards[2].h, 210)
})

Deno.test('cardsToText: tags a resized card so the emphasis survives into the prompt', () => {
  const out = cardsToText({
    cards: [
      { text: 'Headline', size: 'huge', y: 0 },
      { text: 'Normal', y: 10 },
      { text: 'Aside', color: 'blue', w: 150, h: 92, y: 20 },
    ],
  })
  assertStringIncludes(out, '[huge] Headline')
  assertStringIncludes(out, '- Normal')
  assertStringIncludes(out, '[blue, small] Aside')
})
