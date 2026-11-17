// Just enough of Bun's types for local/server.ts, so the repo's typecheck
// covers this package without installing @types/bun.
declare module 'bun:sqlite' {
  import type { SqlDb } from './sql'
  export class Database implements SqlDb {
    constructor(path: string, options?: { create?: boolean })
    exec(sql: string): void
    prepare(sql: string): import('./sql').SqlStatement
  }
}

declare const Bun: {
  serve(options: { hostname: string; port: number; fetch: (req: Request) => Response | Promise<Response> }): unknown
}
