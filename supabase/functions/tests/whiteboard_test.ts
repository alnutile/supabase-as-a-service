// deno test — the pure whiteboard scene helpers (sceneToText / normalizeElements /
// buildScene). Kept pure so the DB side of the whiteboard builtins needs no mocks.
import { assertEquals, assertStringIncludes } from 'jsr:@std/assert@1'
import { buildScene, elementCount, normalizeElements, sceneToText } from '../_shared/whiteboard_scene.ts'

Deno.test('sceneToText: empty scene → placeholder', () => {
  assertEquals(sceneToText({}), '(empty whiteboard — nothing drawn yet)')
  assertEquals(sceneToText(null), '(empty whiteboard — nothing drawn yet)')
  assertEquals(sceneToText({ elements: [] }), '(empty whiteboard — nothing drawn yet)')
})

Deno.test('sceneToText: free-standing text elements are listed', () => {
  const out = sceneToText({ elements: [{ id: 't1', type: 'text', text: 'Roadmap' }] })
  assertStringIncludes(out, 'Text on the board:')
  assertStringIncludes(out, '- Roadmap')
})

Deno.test('sceneToText: shapes with bound labels are named', () => {
  const scene = {
    elements: [
      { id: 'r1', type: 'rectangle' },
      { id: 'r1-label', type: 'text', text: 'Backend', containerId: 'r1' },
    ],
  }
  const out = sceneToText(scene)
  assertStringIncludes(out, 'Shapes:')
  assertStringIncludes(out, 'rectangle "Backend"')
})

Deno.test('sceneToText: arrows describe their connection using bound labels', () => {
  const scene = {
    elements: [
      { id: 'a', type: 'rectangle' },
      { id: 'a-label', type: 'text', text: 'Client', containerId: 'a' },
      { id: 'b', type: 'rectangle' },
      { id: 'b-label', type: 'text', text: 'Server', containerId: 'b' },
      {
        id: 'arr',
        type: 'arrow',
        startBinding: { elementId: 'a' },
        endBinding: { elementId: 'b' },
      },
    ],
  }
  const out = sceneToText(scene)
  assertStringIncludes(out, 'Connections:')
  assertStringIncludes(out, 'Client → Server')
})

Deno.test('sceneToText: deleted elements are ignored', () => {
  const out = sceneToText({ elements: [{ id: 't', type: 'text', text: 'gone', isDeleted: true }] })
  assertEquals(out, '(empty whiteboard — nothing drawn yet)')
})

Deno.test('normalizeElements: fills required fields + generates ids', () => {
  const [el] = normalizeElements([{ type: 'rectangle', x: 10, y: 20 }])
  assertEquals(el.type, 'rectangle')
  assertEquals(el.x, 10)
  assertEquals(el.y, 20)
  assertEquals(typeof el.id, 'string')
  assertEquals(el.isDeleted, false)
  assertEquals(typeof el.seed, 'number')
  assertEquals(Array.isArray(el.groupIds), true)
})

Deno.test('normalizeElements: a shape label becomes a bound text child', () => {
  const els = normalizeElements([{ type: 'rectangle', label: { text: 'Login' } }])
  assertEquals(els.length, 2)
  const shape = els.find((e) => e.type === 'rectangle')!
  const label = els.find((e) => e.type === 'text')!
  assertEquals(label.text, 'Login')
  assertEquals(label.containerId, shape.id)
  assertEquals(shape.boundElements?.[0]?.id, label.id)
  // and it round-trips through sceneToText
  assertStringIncludes(sceneToText({ elements: els }), 'rectangle "Login"')
})

Deno.test('normalizeElements: arrows get points + an arrowhead', () => {
  const [arr] = normalizeElements([{ type: 'arrow', x: 0, y: 0, width: 100, height: 0 }])
  assertEquals(arr.type, 'arrow')
  assertEquals(Array.isArray(arr.points), true)
  assertEquals(arr.endArrowhead, 'arrow')
})

Deno.test('normalizeElements: ignores garbage', () => {
  assertEquals(normalizeElements([null, 42, {}, { type: '' }]).length, 0)
  assertEquals(normalizeElements('nope' as unknown).length, 0)
})

Deno.test('buildScene: replace vs append', () => {
  const first = buildScene({}, [{ type: 'rectangle' }], 'replace')
  assertEquals(elementCount(first), 1)
  const appended = buildScene(first, [{ type: 'ellipse' }], 'append')
  assertEquals(elementCount(appended), 2)
  const replaced = buildScene(first, [{ type: 'ellipse' }], 'replace')
  assertEquals(elementCount(replaced), 1)
})

Deno.test('buildScene: preserves appState/files across an append', () => {
  const scene = buildScene(
    { elements: [], appState: { viewBackgroundColor: '#eee' }, files: { a: 1 } },
    [{ type: 'text', text: 'hi' }],
    'append',
  )
  assertEquals(scene.appState?.viewBackgroundColor, '#eee')
  assertEquals((scene.files as { a: number }).a, 1)
})
