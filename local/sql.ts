// The tiny slice of SQLite API this package uses. Both `bun:sqlite` (the real
// server) and Node's `node:sqlite` (the vitest suite) provide exactly this, so
// the same store code runs under either.
export interface SqlStatement {
  all(...params: SqlValue[]): unknown[]
  get(...params: SqlValue[]): unknown
  run(...params: SqlValue[]): unknown
}

export interface SqlDb {
  exec(sql: string): void
  prepare(sql: string): SqlStatement
}

export type SqlValue = string | number | null
