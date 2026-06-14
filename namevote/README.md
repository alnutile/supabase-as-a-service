# Name Vote

A tiny, password-protected web app for a small team to brainstorm and vote on a
team name. Claude proposes fresh names on demand — and gets **smarter every round**
because it reads the whole history: the brief, which names earned votes, and every
comment you've left. Add your own names too. Everything lives in SQLite.

Built for the "three enterprise builders in different countries" use case, but the
brief is editable in the UI so you can point it at anything.

## What it does

- **Shared-password login.** One password (an env var) gets people in; each person
  types their name so votes and comments are attributed. Sessions are signed cookies.
- **Generate names with Claude.** Click *Generate* and Claude returns new names
  grounded in the brief + all prior votes and feedback. Duplicates are skipped.
- **Vote.** One toggle-vote per person per name; the board sorts by votes.
- **Feedback loop.** Leave per-name comments and general "directions to go / avoid"
  notes — these are exactly what the next generation round learns from.
- **Editable brief.** Tune the description Claude works from at any time.

Because it's password-protected, the Anthropic key stays a **server-side env var** —
the browser never sees it.

## Run locally

```bash
cd namevote
npm install
cp .env.example .env   # fill in APP_PASSWORD and ANTHROPIC_API_KEY
npm start              # http://localhost:3000
```

## Deploy on Railway

1. **New Project → Deploy from GitHub repo**, pick this repo.
2. Set the service **Root Directory** to `namevote` (Settings → Source). That makes
   Railway build this folder, not the parent app.
3. Add **Variables**:
   - `APP_PASSWORD` — the shared password you'll give the team.
   - `ANTHROPIC_API_KEY` — your key.
   - `SESSION_SECRET` — any long random string (keeps people signed in across deploys).
4. (Recommended) Add a **Volume** mounted at `/data` and set `DATABASE_PATH=/data/namevote.db`
   so names/votes survive redeploys — Railway's container filesystem is otherwise ephemeral.
5. Deploy. Railway gives you a public URL; share it + the password with the team.

`railway.json` already sets the build (Nixpacks) and `npm start` for you.

## Environment variables

| Var | Required | Notes |
| --- | --- | --- |
| `APP_PASSWORD` | yes | Shared login password. |
| `ANTHROPIC_API_KEY` | yes | Server-side only. |
| `SESSION_SECRET` | recommended | Signs the session cookie; random per-restart if unset. |
| `ANTHROPIC_MODEL` | no | Defaults to `claude-opus-4-8`. |
| `ANTHROPIC_EFFORT` | no | `low`/`medium`/`high`/`max` (default `medium`). |
| `DATABASE_PATH` | no | Defaults to `./data/namevote.db`; point at a volume to persist. |
| `PORT` | no | Defaults to `3000` (Railway sets this automatically). |

## How the AI learns from feedback

Every *Generate* call sends Claude: the current brief, the full list of names with
their vote counts (so it leans into winners), and every feedback note (per-name and
general). It's asked for distinct, enterprise-credible names that build on what's
working and address the feedback — returned as strict JSON (structured outputs) so
parsing never breaks. The more you vote and comment, the more targeted each round gets.

## Stack

Express + better-sqlite3 + the Anthropic SDK. No build step, no frontend framework —
plain HTML/CSS/JS served from `public/`.
