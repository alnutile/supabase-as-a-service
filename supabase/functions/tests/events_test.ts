// deno test — the event-listener matching logic (the gate that decides which
// listeners fire for a given event). Kept pure so the dispatcher's DB/model side
// effects don't need mocking.
import { assertEquals } from 'jsr:@std/assert@1'
import { matchListener, substituteEvent, typeMatches, type EventRow } from '../_shared/events.ts'

Deno.test('typeMatches: exact, wildcard, and star', () => {
  assertEquals(typeMatches('file.created', 'file.created'), true)
  assertEquals(typeMatches('file.created', 'file.deleted'), false)
  assertEquals(typeMatches('file.*', 'file.created'), true)
  assertEquals(typeMatches('file.*', 'file.deleted'), true)
  assertEquals(typeMatches('file.*', 'file'), true)
  assertEquals(typeMatches('file.*', 'filesystem.created'), false) // must break on the dot
  assertEquals(typeMatches('*', 'anything.at.all'), true)
  assertEquals(typeMatches('', 'file.created'), false)
})

Deno.test('matchListener: type must match', () => {
  const ev: EventRow = { type: 'file.created', entity_type: 'file', data: {} }
  assertEquals(matchListener(ev, { event_type: 'file.created' }), true)
  assertEquals(matchListener(ev, { event_type: 'file.*' }), true)
  assertEquals(matchListener(ev, { event_type: '*' }), true)
  assertEquals(matchListener(ev, { event_type: 'artifact.created' }), false)
})

Deno.test('matchListener: entity_type filter', () => {
  const ev: EventRow = { type: 'collection.item_added', entity_type: 'file', data: { collection_id: 'c1' } }
  assertEquals(matchListener(ev, { event_type: '*', match: { entity_type: 'file' } }), true)
  assertEquals(matchListener(ev, { event_type: '*', match: { entity_type: 'artifact' } }), false)
})

Deno.test('matchListener: collection_id filter (the headline use case)', () => {
  const ev: EventRow = {
    type: 'collection.item_added',
    entity_type: 'file',
    data: { collection_id: 'fubar-id', item_type: 'file', item_id: 'f1' },
  }
  // "when a file is added to collection Fubar, do X"
  assertEquals(
    matchListener(ev, { event_type: 'collection.item_added', match: { collection_id: 'fubar-id', entity_type: 'file' } }),
    true,
  )
  assertEquals(
    matchListener(ev, { event_type: 'collection.item_added', match: { collection_id: 'other-id' } }),
    false,
  )
})

Deno.test('matchListener: agent added to a collection (the new item type)', () => {
  const ev: EventRow = {
    type: 'collection.item_added',
    entity_type: 'agent',
    data: { collection_id: 'fubar-id', item_type: 'agent', item_id: 'a1' },
  }
  // "when an agent is added to collection Fubar, do X"
  assertEquals(
    matchListener(ev, { event_type: 'collection.item_added', match: { collection_id: 'fubar-id', entity_type: 'agent' } }),
    true,
  )
  // an artifact-scoped listener must NOT fire on an agent membership
  assertEquals(
    matchListener(ev, { event_type: 'collection.item_added', match: { entity_type: 'artifact' } }),
    false,
  )
})

Deno.test('matchListener: source filter for messages', () => {
  const ev: EventRow = { type: 'message.received', entity_type: 'message', data: { source: 'email', subject: 'hi' } }
  assertEquals(matchListener(ev, { event_type: 'message.received', match: { source: 'email' } }), true)
  assertEquals(matchListener(ev, { event_type: 'message.received', match: { source: 'slack' } }), false)
  assertEquals(matchListener(ev, { event_type: 'message.*' }), true)
})

Deno.test('matchListener: empty match object matches any of that type', () => {
  const ev: EventRow = { type: 'todo.completed', entity_type: 'todo', data: {} }
  assertEquals(matchListener(ev, { event_type: 'todo.completed', match: {} }), true)
  assertEquals(matchListener(ev, { event_type: 'todo.completed' }), true)
})

Deno.test('substituteEvent: replaces {{event}} deep in the input', () => {
  const ev: EventRow = { type: 'message.received', entity_id: 'm1', data: { source: 'email' } }
  const input = { note: 'Got {{event}}', nested: { x: ['{{event}}'] }, num: 3 }
  const out = substituteEvent(input, ev) as { note: string; nested: { x: string[] }; num: number }
  const json = JSON.stringify(ev)
  assertEquals(out.note, `Got ${json}`)
  assertEquals(out.nested.x[0], json)
  assertEquals(out.num, 3)
})
