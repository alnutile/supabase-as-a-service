// Hosted backend: Supabase (Postgres + RLS). RLS decides visibility; these
// functions only shape the calls the pages used to make inline.
import { supabase } from '../../supabase'
import type { Backend, CollectionStore, TerminologyStore } from '../stores'
import type { Membership } from '../types'
import { COLLECTION_JOIN } from './collectionKinds'

function check<T>(res: { data: T; error: { message: string } | null }): T {
  if (res.error) throw new Error(res.error.message)
  return res.data
}

async function currentUserId(): Promise<string> {
  const { data } = await supabase.auth.getSession()
  const id = data.session?.user.id
  if (!id) throw new Error('Not signed in')
  return id
}

const terminology: TerminologyStore = {
  async list() {
    return check(await supabase.from('terminology').select('*').order('term', { ascending: true })) ?? []
  },
  async get(id) {
    return check(await supabase.from('terminology').select('*').eq('id', id).maybeSingle())
  },
  async create({ term, definition, notes }) {
    const owner_id = await currentUserId()
    const row = check(
      await supabase
        .from('terminology')
        .insert({ owner_id, term, definition, notes: notes ?? '', visibility: 'private' })
        .select('*')
        .single(),
    )
    if (!row) throw new Error('Could not create the term')
    return row
  },
  async update(id, patch) {
    check(await supabase.from('terminology').update(patch).eq('id', id))
  },
  async remove(id) {
    check(await supabase.from('terminology').delete().eq('id', id))
  },
}

// The join table is picked at runtime, which the generated types can't follow.
// Every join table has the same shape, so we cast to a representative one
// (`collection_files`) and read the dynamic item column loosely.
type JoinRow = Record<string, string>

const collections: CollectionStore = {
  async list() {
    return (
      check(
        await supabase
          .from('collections')
          .select('*')
          .order('pinned', { ascending: false })
          .order('name', { ascending: true }),
      ) ?? []
    )
  },
  async memberships(kind, itemIds) {
    const { table, col } = COLLECTION_JOIN[kind]
    if (itemIds && itemIds.length === 0) return []
    let q = supabase.from(table as 'collection_files').select(`collection_id, ${col}`)
    if (itemIds) q = q.in(col as 'file_id', itemIds)
    const rows = (check(await q) ?? []) as unknown as JoinRow[]
    return rows.map((r): Membership => ({ collectionId: r.collection_id, itemId: r[col] }))
  },
  async create({ name }) {
    const owner_id = await currentUserId()
    const row = check(
      await supabase.from('collections').insert({ owner_id, name, visibility: 'private' }).select().single(),
    )
    if (!row) throw new Error('Could not create the collection')
    return row
  },
  async addItems(kind, collectionId, itemIds) {
    if (!itemIds.length) return
    const { table, col } = COLLECTION_JOIN[kind]
    const added_by = await currentUserId()
    const rows = itemIds.map((id) => ({ collection_id: collectionId, [col]: id, added_by }))
    check(
      await supabase
        .from(table as 'collection_files')
        .upsert(rows as never, { onConflict: `collection_id,${col}`, ignoreDuplicates: true }),
    )
  },
  async removeItems(kind, collectionId, itemIds) {
    if (!itemIds.length) return
    const { table, col } = COLLECTION_JOIN[kind]
    check(
      await supabase
        .from(table as 'collection_files')
        .delete()
        .eq('collection_id', collectionId)
        .in(col as 'file_id', itemIds),
    )
  },
}

export const supabaseBackend: Backend = { name: 'supabase', terminology, collections }
