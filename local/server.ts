// Local second-brain server: owns the SQLite database and serves the app's
// data API on 127.0.0.1 only. Run with Bun:
//
//   bun local/server.ts            (or: npm run local:server)
//
// Env: BRAIN_DB (database file), BRAIN_PORT (default 8787).
import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { createHandler } from './http'
import { defaultDbPath } from './paths'
import { migrate } from './schema'
import { createSqliteBackend } from './store'

const dbPath = defaultDbPath()
mkdirSync(dirname(dbPath), { recursive: true })
const db = new Database(dbPath, { create: true })
db.exec('pragma journal_mode = wal')
const applied = migrate(db)

const port = Number(process.env.BRAIN_PORT || 8787)
const handle = createHandler(createSqliteBackend(db), { dbPath })

Bun.serve({ hostname: '127.0.0.1', port, fetch: handle })

console.log(`second brain: http://127.0.0.1:${port}  db: ${dbPath}`)
if (applied.length) console.log(`applied migrations: ${applied.join(', ')}`)
