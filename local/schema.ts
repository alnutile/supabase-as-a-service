// SQLite schema for the local second brain, as ordered migrations. Applied on
// startup; each version runs once and is recorded in schema_migrations.
//
// Shapes mirror the Postgres rows the UI already renders (see
// src/lib/data/types.ts) so the same pages work unchanged. Single user, so no
// RLS: owner_id is kept only so rows keep their familiar shape.
import type { SqlDb } from './sql'

export const MIGRATIONS: Array<{ version: number; name: string; sql: string }> = [
  {
    version: 1,
    name: 'terminology_and_collections',
    sql: `
      create table terminology (
        id          text primary key,
        owner_id    text not null,
        term        text not null,
        definition  text not null,
        notes       text not null default '',
        source      text not null default '{}',
        visibility  text not null default 'private',
        created_at  text not null,
        updated_at  text not null
      );

      create table collections (
        id          text primary key,
        owner_id    text not null,
        name        text not null,
        description text not null default '',
        color       text,
        visibility  text not null default 'private',
        pinned      integer not null default 0,
        created_at  text not null,
        updated_at  text not null
      );

      -- One join table for every item kind (Postgres has one per kind).
      create table collection_items (
        kind          text not null,
        collection_id text not null references collections(id) on delete cascade,
        item_id       text not null,
        created_at    text not null,
        primary key (kind, collection_id, item_id)
      );
      create index collection_items_item on collection_items(kind, item_id);

      -- An item leaves its collections when it is deleted.
      create trigger terminology_drop_memberships after delete on terminology
      begin
        delete from collection_items where kind = 'term' and item_id = old.id;
      end;

      -- Keyword search (FTS5, docs/local-first.md "Retrieval: FTS5 first").
      create virtual table terminology_fts using fts5(
        term, definition, notes, content='terminology', content_rowid='rowid'
      );
      create trigger terminology_fts_ai after insert on terminology begin
        insert into terminology_fts(rowid, term, definition, notes)
        values (new.rowid, new.term, new.definition, new.notes);
      end;
      create trigger terminology_fts_ad after delete on terminology begin
        insert into terminology_fts(terminology_fts, rowid, term, definition, notes)
        values ('delete', old.rowid, old.term, old.definition, old.notes);
      end;
      create trigger terminology_fts_au after update on terminology begin
        insert into terminology_fts(terminology_fts, rowid, term, definition, notes)
        values ('delete', old.rowid, old.term, old.definition, old.notes);
        insert into terminology_fts(rowid, term, definition, notes)
        values (new.rowid, new.term, new.definition, new.notes);
      end;
    `,
  },
]

/** Bring a database up to the latest schema. Safe to call on every start. */
export function migrate(db: SqlDb): number[] {
  db.exec('pragma foreign_keys = on')
  db.exec(`create table if not exists schema_migrations (
    version integer primary key, name text not null, applied_at text not null
  )`)
  const done = new Set(
    (db.prepare('select version from schema_migrations').all() as Array<{ version: number }>).map((r) => r.version),
  )
  const applied: number[] = []
  for (const m of MIGRATIONS) {
    if (done.has(m.version)) continue
    db.exec('begin')
    try {
      db.exec(m.sql)
      db.prepare('insert into schema_migrations (version, name, applied_at) values (?, ?, ?)').run(
        m.version,
        m.name,
        new Date().toISOString(),
      )
      db.exec('commit')
    } catch (err) {
      db.exec('rollback')
      throw err
    }
    applied.push(m.version)
  }
  return applied
}
