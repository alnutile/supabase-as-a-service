// deno test — the pure card-board helpers (cardsToText / normalizeCards /
// buildCards). Kept pure so the DB side of the card-board builtins needs no mocks.
import { assertEquals, assertStringIncludes } from 'jsr:@std/assert@1'
import { buildCards, cardCount, cardsToText, normalizeCards } from '../_shared/card_board.ts'

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
