# Local second brain

The app running on your own machine: no Supabase, everything in one SQLite
file. Plan and status: [docs/local-first.md](../docs/local-first.md).

## Run it (macOS)

You need Node 20+ and Bun.

```bash
brew install oven-sh/bun/bun
```

```bash
npm install
```

```bash
npm run dev:local
```

Open http://127.0.0.1:5173. It starts on **Terminology**, the first area moved
onto the local backend. Other areas say "Not available locally yet" until they
move over. Ctrl-C stops both servers.

Your data lives in `~/Library/Application Support/SecondBrain/brain.db`. To
try things without touching it, point at a scratch file:

```bash
BRAIN_DB=/tmp/brain-test.db npm run dev:local
```

## What runs

- `local/server.ts`: a Bun server on `127.0.0.1:8787` (`BRAIN_PORT` to change)
  that owns the database. It listens on loopback only.
- Vite in local mode (`VITE_BACKEND=local`), also on loopback. It forwards
  `/api` to the server, so the server needs no CORS and other websites can't
  call it from your browser.

## Layout

| File | What it is |
|---|---|
| `server.ts` | Entry point: opens the database, migrates, serves HTTP |
| `http.ts` | The JSON API as a plain `Request -> Response` handler |
| `store.ts` | The SQLite implementation of `src/lib/data/stores.ts` |
| `schema.ts` | Ordered migrations, applied on start |
| `sql.ts` | The small SQLite API shared by `bun:sqlite` and `node:sqlite` |
| `store.test.ts` | The shared backend contract against real SQLite, directly and over HTTP |

## Moving another area onto the local backend

1. Add its store to `src/lib/data/stores.ts`, then implement it in
   `supabase/`, `memory/` and `local/store.ts`, and extend `contract.ts`.
2. Add a migration in `schema.ts` and routes in `http.ts`, and add it to the
   HTTP client in `src/lib/data/local/index.ts`.
3. Switch the page to `data.*`, add its route to `LOCAL_READY_ROUTES` in
   `src/lib/mode.ts`, and mark its nav item `localReady` in `src/lib/nav.ts`.
