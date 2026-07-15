// deno test — validateWidget (dashboard widget spec validation). Pure, no mocks.
import { assertEquals } from 'jsr:@std/assert@1'
import { validateWidget, type ValidWidget } from '../_shared/widgets.ts'

Deno.test('validateWidget: rejects missing title / bad kind / bad source', () => {
  assertEquals(typeof validateWidget({ kind: 'stat', source: 'todos' }), 'string')
  assertEquals(typeof validateWidget({ title: 'x', kind: 'pie', source: 'todos' }), 'string')
  assertEquals(typeof validateWidget({ title: 'x', kind: 'stat', source: 'users' }), 'string')
})

Deno.test('validateWidget: accepts a clean widget and strips the spec', () => {
  const w = validateWidget({
    title: 'My artifacts today',
    kind: 'list',
    source: 'artifacts',
    spec: { mine: true, window: 'today', limit: 3, evil: 'x' },
  }) as ValidWidget
  assertEquals(w.kind, 'list')
  assertEquals(w.source, 'artifacts')
  assertEquals(w.spec, { window: 'today', mine: true, limit: 3 })
})

Deno.test('validateWidget: status only survives for todos, limit clamps', () => {
  const todo = validateWidget({ title: 't', kind: 'stat', source: 'todos', spec: { status: 'open' } }) as ValidWidget
  assertEquals(todo.spec.status, 'open')
  const files = validateWidget({ title: 'f', kind: 'stat', source: 'files', spec: { status: 'done' } }) as ValidWidget
  assertEquals(files.spec.status, undefined)
  const big = validateWidget({ title: 'l', kind: 'list', source: 'links', spec: { limit: 999 } }) as ValidWidget
  assertEquals(big.spec.limit, 20)
})

Deno.test('validateWidget: mine:false and bad window are dropped', () => {
  const w = validateWidget({ title: 'a', kind: 'stat', source: 'activity', spec: { mine: false, window: 'forever' } }) as ValidWidget
  assertEquals(w.spec, {})
})
