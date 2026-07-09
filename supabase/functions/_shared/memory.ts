// Per-user memory — the assistant's durable, personal profile of a user.
//
// Two jobs:
//   1. The builtin handlers (remember / list_memories / update_memory / forget)
//      — the CRUD the assistant + agents call, shared by all three agent loops
//      via runBuiltin and re-exposed by the MCP server, so internal and external
//      Claude use one code path (the files.ts / builtins.ts convention).
//   2. loadUserMemories(db, userId) — turns a user's memories into a system-prompt
//      block, injected by the chat + scheduler loops so a new chat / scheduled run
//      starts pre-warmed. Webhook + Slack deliberately don't inject it (external
//      callers must not see personal memory).
//
// Memory is OWNER-ONLY (mirrors conversations/files). These handlers run with
// the service role, so every query is re-scoped to the caller's owner_id in code
// — the RLS re-enforcement pattern the other builtins use.
//
// The db client is typed `any` (like collections.ts) rather than importing
// supabase-js, so this module stays import-pure and formatMemoriesBlock can be
// unit-tested without a node_modules resolution step.
// deno-lint-ignore no-explicit-any
type DB = any

interface MemoryRow {
  id: string
  content: string
  key: string | null
  category: string
  pinned: boolean
  updated_at?: string
}

const LIST_DEFAULT = 50
const LIST_MAX = 200
// Budget for the injected block. ~8k chars ≈ 2k tokens — plenty for a personal
// profile without crowding the conversation; the rest is truncated with a note.
const INJECT_MAX_CHARS = 8000
const CONTENT_MAX = 2000

async function logActivity(
  db: DB,
  type: string,
  summary: string,
  detail: Record<string, unknown>,
  actorId: string | null,
) {
  try {
    await db.from('activity_log').insert({ type, summary, detail, actor_id: actorId })
  } catch {
    // best-effort
  }
}

function clampLimit(v: unknown, dflt: number, max: number): number {
  let n = Number(v ?? dflt)
  if (!Number.isFinite(n) || n <= 0) n = dflt
  return Math.min(Math.trunc(n), max)
}

// Pure: render memory rows as an injectable system block, newest/pinned first,
// capped to a char budget with a truncation note. Returns '' for no memories.
// Kept side-effect-free so it's unit-tested in tests/memory_test.ts.
export function formatMemoriesBlock(memories: MemoryRow[], maxChars = INJECT_MAX_CHARS): string {
  if (!memories.length) return ''
  const lines: string[] = []
  let used = 0
  let omitted = 0
  for (const m of memories) {
    const text = (m.content ?? '').trim()
    if (!text) continue
    const tag = m.category && m.category !== 'general' ? `[${m.category}] ` : ''
    const pin = m.pinned ? '📌 ' : ''
    const line = `- ${pin}${tag}${text}`
    if (used + line.length > maxChars && lines.length) {
      omitted = memories.length - lines.length
      break
    }
    lines.push(line)
    used += line.length + 1
  }
  if (!lines.length) return ''
  let block =
    `# What you remember about this user\n` +
    `This is durable, already-known background about the person you're talking to — ` +
    `don't re-ask for it. Use it to tailor your answers.\n\n` +
    lines.join('\n')
  if (omitted > 0) block += `\n…(${omitted} more memory(ies) not shown)`
  return block
}

// Read the caller's memories and return the injectable block (or '' if none).
// Ordered pinned-first, then most-recently-updated — the order formatMemoriesBlock
// keeps when it truncates to the budget.
export async function loadUserMemories(db: DB | null, userId: string | null): Promise<string> {
  if (!db || !userId) return ''
  try {
    const { data } = await db
      .from('user_memories')
      .select('id, content, key, category, pinned, updated_at')
      .eq('owner_id', userId)
      .order('pinned', { ascending: false })
      .order('updated_at', { ascending: false })
      .limit(LIST_MAX)
    return formatMemoriesBlock((data ?? []) as MemoryRow[])
  } catch {
    return ''
  }
}

// --- builtin handlers --------------------------------------------------------

export async function remember(
  db: DB | null,
  userId: string | null,
  input: Record<string, unknown>,
): Promise<string> {
  if (!db || !userId) return 'Memory is unavailable.'
  const content = String(input?.content ?? '').trim().slice(0, CONTENT_MAX)
  if (!content) return 'Nothing to remember — pass the fact/preference as "content".'
  const key = typeof input?.key === 'string' && input.key.trim() ? input.key.trim().slice(0, 120) : null
  const category = typeof input?.category === 'string' && input.category.trim()
    ? input.category.trim().slice(0, 40)
    : 'general'
  const pinned = input?.pinned === true

  // With a key, upsert in place (so a refined fact overwrites, not duplicates).
  if (key) {
    const { data: existing } = await db
      .from('user_memories')
      .select('id')
      .eq('owner_id', userId)
      .eq('key', key)
      .maybeSingle()
    if (existing) {
      const { error } = await db
        .from('user_memories')
        .update({ content, category, pinned })
        .eq('id', existing.id)
        .eq('owner_id', userId)
      if (error) return `Could not update the memory: ${error.message}`
      await logActivity(db, 'memory.updated', `Updated memory "${key}"`, { key }, userId)
      return `Updated what I remember (key "${key}"): ${content}`
    }
  }

  const { data, error } = await db
    .from('user_memories')
    .insert({
      owner_id: userId,
      content,
      key,
      category,
      pinned,
      source: (input?.source && typeof input.source === 'object') ? input.source : {},
    })
    .select('id')
    .single()
  if (error) return `Could not save the memory: ${error.message}`
  await logActivity(db, 'memory.created', `Remembered: ${content.slice(0, 80)}`, { id: data.id, key, category }, userId)
  return `Got it — I'll remember that${key ? ` (key "${key}")` : ''}. It'll be there at the start of your next chat.`
}

export async function listMemories(
  db: DB | null,
  userId: string | null,
  input: Record<string, unknown>,
): Promise<string> {
  if (!db || !userId) return 'Memory is unavailable.'
  const limit = clampLimit(input?.limit, LIST_DEFAULT, LIST_MAX)
  let q = db
    .from('user_memories')
    .select('id, content, key, category, pinned')
    .eq('owner_id', userId)
    .order('pinned', { ascending: false })
    .order('updated_at', { ascending: false })
    .limit(limit)
  const category = typeof input?.category === 'string' ? input.category.trim() : ''
  if (category) q = q.eq('category', category)
  const query = typeof input?.query === 'string' ? input.query.trim() : ''
  if (query) q = q.ilike('content', `%${query}%`)
  const { data, error } = await q
  if (error) return `Could not read memories: ${error.message}`
  const rows = (data ?? []) as MemoryRow[]
  if (!rows.length) return 'No memories saved yet. Use remember to save a durable fact or preference about the user.'
  return rows
    .map((m) => {
      const tag = m.category && m.category !== 'general' ? ` [${m.category}]` : ''
      const pin = m.pinned ? ' 📌' : ''
      const k = m.key ? ` (key: ${m.key})` : ''
      return `• ${m.content}${tag}${pin}${k} — id: ${m.id}`
    })
    .join('\n')
}

// Find a memory for this owner by id or key.
async function resolveMemory(
  db: DB,
  userId: string,
  input: Record<string, unknown>,
): Promise<{ id: string } | null> {
  const id = String(input?.id ?? '').trim()
  const key = String(input?.key ?? '').trim()
  if (id) {
    const { data } = await db.from('user_memories').select('id').eq('id', id).eq('owner_id', userId).maybeSingle()
    return data ? { id: data.id as string } : null
  }
  if (key) {
    const { data } = await db.from('user_memories').select('id').eq('key', key).eq('owner_id', userId).maybeSingle()
    return data ? { id: data.id as string } : null
  }
  return null
}

export async function updateMemory(
  db: DB | null,
  userId: string | null,
  input: Record<string, unknown>,
): Promise<string> {
  if (!db || !userId) return 'Memory is unavailable.'
  const target = await resolveMemory(db, userId, input)
  if (!target) return 'No matching memory — pass an id or key (list_memories shows them).'
  const patch: Record<string, unknown> = {}
  if (typeof input?.content === 'string' && input.content.trim()) patch.content = input.content.trim().slice(0, CONTENT_MAX)
  if (typeof input?.category === 'string' && input.category.trim()) patch.category = input.category.trim().slice(0, 40)
  if (typeof input?.pinned === 'boolean') patch.pinned = input.pinned
  if (!Object.keys(patch).length) return 'Nothing to update — pass content, category, and/or pinned.'
  const { error } = await db.from('user_memories').update(patch).eq('id', target.id).eq('owner_id', userId)
  if (error) return `Could not update the memory: ${error.message}`
  await logActivity(db, 'memory.updated', 'Updated a memory', { id: target.id, fields: Object.keys(patch) }, userId)
  return `Updated the memory.`
}

export async function forget(
  db: DB | null,
  userId: string | null,
  input: Record<string, unknown>,
): Promise<string> {
  if (!db || !userId) return 'Memory is unavailable.'
  const target = await resolveMemory(db, userId, input)
  if (!target) return 'No matching memory to forget — pass an id or key (list_memories shows them).'
  const { error } = await db.from('user_memories').delete().eq('id', target.id).eq('owner_id', userId)
  if (error) return `Could not forget the memory: ${error.message}`
  await logActivity(db, 'memory.forgotten', 'Forgot a memory', { id: target.id }, userId)
  return `Forgotten.`
}
