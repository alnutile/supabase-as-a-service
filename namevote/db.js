import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const DB_PATH = process.env.DATABASE_PATH || './data/namevote.db';
mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS names (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL UNIQUE COLLATE NOCASE,
    rationale  TEXT NOT NULL DEFAULT '',
    source     TEXT NOT NULL DEFAULT 'human',  -- 'human' | 'ai'
    created_by TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS votes (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name_id    INTEGER NOT NULL REFERENCES names(id) ON DELETE CASCADE,
    voter      TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (name_id, voter)
  );

  CREATE TABLE IF NOT EXISTS feedback (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name_id    INTEGER REFERENCES names(id) ON DELETE CASCADE,  -- NULL = general feedback
    voter      TEXT NOT NULL,
    body       TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// The team brief — editable in the UI, fed to Claude on every generation.
const DEFAULT_BRIEF = `We are a team of Enterprise builders looking for a team name.
- Three people for now, maybe more soon.
- We are based in different countries.
- We each bring a mix of skills (build, design, ops, data).
- We build with no-code / low-code tools like Softr, Noloco, Xano, Zapier, and more.
We want a name that feels sharp, modern, and credible to enterprise clients — not cheesy.`;

const seedBrief = db.prepare(
  `INSERT INTO settings (key, value) VALUES ('brief', ?)
   ON CONFLICT(key) DO NOTHING`
);
seedBrief.run(DEFAULT_BRIEF);

export function getBrief() {
  const row = db.prepare(`SELECT value FROM settings WHERE key = 'brief'`).get();
  return row ? row.value : DEFAULT_BRIEF;
}

export function setBrief(value) {
  db.prepare(
    `INSERT INTO settings (key, value) VALUES ('brief', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(value);
}
