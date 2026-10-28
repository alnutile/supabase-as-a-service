# Desktop app (Tauri)

Run SupaNet on your own machine with nothing hosted: a desktop app that starts a local
Supabase stack in Docker and opens the workspace in its own window.

## Requirements

- **Docker** — Docker Desktop, OrbStack or Colima, running.
- **Supabase CLI** — `brew install supabase/tap/supabase` (or see the
  [install guide](https://supabase.com/docs/guides/local-development/cli/getting-started)).
- An **OpenRouter API key** for the AI chat (entered in the launcher).

The launcher checks the first two and explains how to fix whatever is missing.

## What happens at launch

1. **Launcher window** — checks Docker and the Supabase CLI, and collects settings (OpenRouter
   key, optional default model, whether to stop Supabase on quit). Settings live in the app's
   config dir (`~/Library/Application Support/studio.dailyai.supanet/settings.json` on macOS).
2. **Prepare** — copies the bundled `supabase/` project (config, migrations, functions) into
   the app-data dir under `stack/`, with `project_id = "supanet-desktop"` so its containers
   never collide with a developer's own `supabase start` of this repo.
3. **`supabase start`** — the first run pulls the Docker images (several minutes) and applies
   every migration. Later runs reuse the existing database volume. The logging services
   (`vector`, `logflare`) are skipped, and the CLI's own health-check deadline is ignored:
   on a first run or a busy Docker host it gives up (and tears everything down) while the
   services are still starting. Instead the app polls the database API, auth and storage
   through the gateway until each answers, for up to 5 minutes.
4. **`supabase migration up --local`** — applies migrations that shipped in an app update.
5. **Scheduled jobs** — calls `setup_automation_cron` (migration 0094) with the gateway's
   in-network address so scheduled agents and event dispatch reach the local functions.
6. **`supabase functions serve`** — with the OpenRouter settings as the env file (the local
   equivalent of `supabase secrets set`).
7. **Workspace window** — loads the same SPA the web build serves. The local API URL and anon
   key are injected as `window.__SUPANET_CONFIG__`, which `src/lib/supabase.ts` prefers over
   the build-time `VITE_*` vars.

The first user to sign up becomes the admin, exactly as on a hosted workspace. Local auth
doesn't require email confirmation; magic-link emails land in the local mail inbox (Mailpit,
linked from `supabase status`).

On quit, the functions server is stopped and — unless you turned it off — `supabase stop`
runs. Your data stays in the Docker volume either way.

## Developing

```bash
npm run desktop:dev     # build the SPA + launcher, run the app with a debug Rust build
npm run desktop:build   # release bundle (.app / .dmg on macOS, .msi on Windows, …)
```

Both run `npm run desktop:frontend` first: the normal `npm run build`, then the launcher page
(`src-tauri/launcher/`) copied into `dist/launcher/`. The desktop app loads `dist/` directly
(no Vite dev server), so for UI work keep using `npm run dev` against any Supabase project.

| Path | What it is |
| --- | --- |
| `src-tauri/src/lib.rs` | App setup, the `open_workspace` command that creates the main window |
| `src-tauri/src/stack.rs` | Prereq checks, settings, the stack boot sequence, shutdown |
| `src-tauri/launcher/index.html` | The launcher UI (plain HTML/JS — it runs before any stack exists) |
| `src-tauri/tauri.conf.json` | Windows, bundle resources (`supabase/` is shipped with the app) |

## Known gaps (beta)

- **Share links point at the app, not the internet.** Public/unlisted artifact links,
  `/p/:slug` pages and invite links use the window's origin, which is local to the app.
  Webhooks, inbound email, Slack events and the MCP endpoint are only reachable from this
  machine (`http://127.0.0.1:54321/functions/v1/…`) unless you add a tunnel.
- **No code signing / auto-update yet** — release bundles are unsigned.
- **Other secrets** (email providers, Slack, Whisper, GitHub) aren't in the launcher yet; add
  them to `stack/functions.env` in the app-data dir and restart.
- The Supabase CLI and Docker are not bundled; they must be installed separately.
