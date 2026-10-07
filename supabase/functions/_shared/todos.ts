// Pure to-do visibility vocabulary, shared by every non-browser writer.
//
// A to-do is either `private` (owner + admins) or `workspace` — the whole team
// can see it, tick it off and reorder it. Three surfaces set that field and they
// must agree on what counts as valid: the `create_todo` / `update_todo` builtins
// (the in-app assistant, the agent loops, `run-tool`, the CLI, and the MCP
// server, which delegates to the same handlers) and the REST `todos` function.
//
// Two deliberate choices live here:
//   * "team" and "shared" normalize to `workspace`. Those are the words a person
//     says, so they are the words a model repeats back into a tool call.
//   * An unrecognised value is `null` (an error), never a silent fall back to
//     `private`. A script that typos this would otherwise report success while
//     the to-do stayed invisible to everyone but its owner — the exact failure
//     this vocabulary exists to prevent.

export const TODO_VISIBILITIES = ['private', 'workspace'] as const

export type TodoVisibility = (typeof TODO_VISIBILITIES)[number]

/**
 * Normalize a caller-supplied to-do visibility.
 *
 * Returns the canonical value, `null` when the input is not a recognised
 * visibility (the caller should reject the request), or `undefined` when the
 * caller said nothing at all (the caller should leave the field alone).
 */
export function normalizeTodoVisibility(v: unknown): TodoVisibility | null | undefined {
  if (v === undefined || v === null) return undefined
  const s = String(v).trim().toLowerCase()
  if (!s) return undefined
  if (s === 'team' || s === 'shared') return 'workspace'
  return (TODO_VISIBILITIES as readonly string[]).includes(s) ? (s as TodoVisibility) : null
}

/** Human-readable note for a tool result, so the model can report what changed. */
export function visibilityNote(v: TodoVisibility | null | undefined, verb = 'is'): string {
  if (v === 'workspace') return ` It ${verb} visible to the whole team.`
  if (v === 'private') return ` It ${verb} private to you.`
  return ''
}

export type TodoListRow = {
  id: string
  title: string
  notes?: string | null
  due_date: string | null
  done: boolean
  status: string | null
  source: string | null
  visibility: string | null
}

// Per-to-do cap on the notes body in list_todos, so one pasted wall of text
// can't crowd every other to-do out of the tool-result budget.
export const TODO_NOTES_CAP = 2000

/**
 * Render list_todos output: one line per to-do (checkbox, title, lane/due/
 * provenance/team, id) followed by its notes, indented, when it has any. The
 * notes used to be dropped entirely, so an agent saw only titles and had no
 * way to read the detail a person wrote down.
 */
export function formatTodoList(rows: TodoListRow[], notesCap = TODO_NOTES_CAP): string {
  return rows
    .map((t) => {
      const meta = [t.status ?? (t.done ? 'done' : 'triage')]
      if (t.due_date) meta.push(`due ${t.due_date}`)
      if (t.source) meta.push(`from ${t.source}`)
      // Say which ones the team can see, so "share these with the team" has
      // something to act on without a second lookup.
      if (t.visibility === 'workspace') meta.push('team')
      const head = `• [${t.done ? 'x' : ' '}] ${t.title} (${meta.join(', ')}) — ${t.id}`
      const notes = (t.notes ?? '').trim()
      if (!notes) return head
      const clipped = notes.length > notesCap
      const body = (clipped ? notes.slice(0, notesCap) : notes).replace(/\r\n/g, '\n')
      const indented = body.split('\n').map((l) => `    ${l}`).join('\n')
      return `${head}\n  notes${clipped ? ` (first ${notesCap} chars)` : ''}:\n${indented}`
    })
    .join('\n')
}
