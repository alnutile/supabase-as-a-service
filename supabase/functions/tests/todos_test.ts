// To-do visibility vocabulary: the one place the REST API, the CLI/run-tool
// path, the agent loops and the MCP server agree on what "team-visible" means.
//
// The bug this guards: before this existed, `create_todo` hardcoded `private`,
// so every to-do filed by an agent, a script, or an external Claude was
// owner-only with no argument to change it. The REST function accepted
// `visibility` but ignored anything it didn't recognise, which silently left a
// to-do private while the caller believed it was shared.

import { assertEquals } from 'jsr:@std/assert'
import { normalizeTodoVisibility, TODO_VISIBILITIES, visibilityNote } from '../_shared/todos.ts'

Deno.test('normalizeTodoVisibility accepts the canonical values', () => {
  assertEquals(normalizeTodoVisibility('private'), 'private')
  assertEquals(normalizeTodoVisibility('workspace'), 'workspace')
})

Deno.test('normalizeTodoVisibility accepts the words a person says for a shared task', () => {
  assertEquals(normalizeTodoVisibility('team'), 'workspace')
  assertEquals(normalizeTodoVisibility('shared'), 'workspace')
  assertEquals(normalizeTodoVisibility('Team'), 'workspace')
  assertEquals(normalizeTodoVisibility('  WORKSPACE  '), 'workspace')
})

Deno.test('normalizeTodoVisibility returns undefined when the caller said nothing', () => {
  // undefined means "leave the field alone", which is what keeps a PATCH that
  // only changes a title from rewriting who can see the to-do.
  assertEquals(normalizeTodoVisibility(undefined), undefined)
  assertEquals(normalizeTodoVisibility(null), undefined)
  assertEquals(normalizeTodoVisibility('   '), undefined)
})

Deno.test('normalizeTodoVisibility rejects anything else rather than defaulting to private', () => {
  // The whole point: a typo must surface as an error. Falling back to `private`
  // would report success while the team still could not see the to-do.
  assertEquals(normalizeTodoVisibility('workspaces'), null)
  assertEquals(normalizeTodoVisibility('public'), null)
  assertEquals(normalizeTodoVisibility('everyone'), null)
  assertEquals(normalizeTodoVisibility(42), null)
  assertEquals(normalizeTodoVisibility({ visibility: 'workspace' }), null)
})

Deno.test('TODO_VISIBILITIES is the pair the todos table allows', () => {
  assertEquals([...TODO_VISIBILITIES], ['private', 'workspace'])
})

Deno.test('visibilityNote only speaks up when visibility was actually set', () => {
  assertEquals(visibilityNote('workspace'), ' It is visible to the whole team.')
  assertEquals(visibilityNote('workspace', 'is now'), ' It is now visible to the whole team.')
  assertEquals(visibilityNote('private', 'is now'), ' It is now private to you.')
  assertEquals(visibilityNote(undefined), '')
  assertEquals(visibilityNote(null), '')
})
