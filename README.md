<div align="center">

# ✺ Intranet

**A friendly, open-source intranet layer on top of [Supabase](https://supabase.com).**

Log in, chat with AI to build things, and share what you make — publicly or locked down. Files, artifacts, and live updates included.

<br/>

![React](https://img.shields.io/badge/React-18-149ECA?logo=react&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white)
![Vite](https://img.shields.io/badge/Vite-5-646CFF?logo=vite&logoColor=white)
![Tailwind CSS](https://img.shields.io/badge/Tailwind-3-38BDF8?logo=tailwindcss&logoColor=white)
![Supabase](https://img.shields.io/badge/Supabase-Postgres%20%7C%20Auth%20%7C%20Realtime%20%7C%20Storage-3FCF8E?logo=supabase&logoColor=white)
![Claude](https://img.shields.io/badge/AI-Claude-D97757?logo=anthropic&logoColor=white)

</div>

---

## What is this?

A small but complete foundation for a team workspace ("intranet") that you fully own. It leans on Supabase for the parts that should be boring and solid, and adds a clean React UI on top:

- 🔐 **Auth** — email/password and magic links via Supabase Auth. A profile is created automatically on signup.
- 💬 **AI chat** — talk to Claude to draft, plan, and build. Replies **stream** token-by-token, persist to Postgres, and sync **live across devices** over realtime websockets.
- ⚡ **Prompts & skills** — **always-on** prompts (a built-in "how this system works" prompt + admin-set workspace context like *"this is Acme's intranet"*) shape every chat; **on-demand** skills run from chat with `/`. The assistant can also **create artifacts directly** ("turn that into something I can share") — they're saved and linked inline. These are the seed for scheduled/promotable agents.
- 📄 **Artifacts** — turn any reply (or a blank page) into a markdown / code / HTML / text artifact with live preview. Share it as **Private**, **Unlisted** (anyone with the link), or **Public** — served to anonymous visitors at `/share/a/:slug`.
- 📁 **Files** — upload to a private, per-user storage bucket and hand out **7-day signed share links** when you want to.
- 🔒 **Invite-only** — the first user bootstraps the workspace and becomes admin; after that, only emails an admin has invited can sign up (enforced in the database).
- 🪝 **Webhooks** — create a webhook to get a public URL, attach a prompt, and every inbound POST is processed by the assistant. Events + results are logged live. The action the result triggers (artifact, chat, outbound call) plugs in next.
- 📱 **Responsive** — works on desktop and phone (slide-in nav, stacked editor).

The Anthropic API key lives **only** on the server (a Supabase Edge Function), never in the browser. Data is protected by Postgres **row-level security**, not by hiding keys.

## How it fits together

```
                 ┌─────────────────────────────────────────────┐
   Browser  ───▶ │  React SPA (Vite + Tailwind)                 │
   (Railway)     │   • Supabase Auth (session)                  │
                 │   • RLS-scoped reads/writes                  │
                 │   • Realtime subscription (websockets)       │
                 └───────────────┬─────────────────────────────┘
                                 │ anon key (safe; RLS protects data)
                                 ▼
                 ┌─────────────────────────────────────────────┐
                 │  Supabase                                    │
                 │   • Postgres + RLS  (profiles, conversations,│
                 │     messages, artifacts, files)              │
                 │   • Auth · Realtime · Storage                │
                 │   • Edge Function `chat`  ───▶ Anthropic API │
                 │     (ANTHROPIC_API_KEY stays server-side)    │
                 └─────────────────────────────────────────────┘
```

## Tech stack

- **Frontend:** React 18 · TypeScript · Vite · Tailwind CSS · React Router
- **Backend:** Supabase — Postgres, Auth, Realtime, Storage, Edge Functions (Deno)
- **AI:** Anthropic Claude (`claude-opus-4-8`) via a streaming edge function
- **Hosting:** any static host; first-class config for [Railway](https://railway.app)

## Project layout

```
src/
  contexts/AuthContext.tsx     Supabase Auth wrapper (session, sign in/up/out)
  components/                  Layout/nav, markdown, sharing controls, icons
  pages/                       Login, Chat, Artifacts, Artifact editor,
                               Public artifact, Files, Settings
  lib/                         Supabase client, chat streaming, types, utils
supabase/
  migrations/0001_init.sql     Schema + RLS + realtime + storage policies
  functions/chat/index.ts      Edge function that streams Claude
railway.json                   Build/serve config for Railway
DEPLOY.md                      End-to-end deployment guide
```

## Quick start (local)

**Prerequisites:** Node 18+, a [Supabase](https://supabase.com) project, an [Anthropic API key](https://console.anthropic.com), and the [Supabase CLI](https://supabase.com/docs/guides/cli).

```bash
# 1. Install
npm install

# 2. Configure the frontend
cp .env.example .env.local
#   then set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY (Project Settings → API)

# 3. Apply the database schema
supabase link --project-ref <your-project-ref>
supabase db push                 # or paste supabase/migrations/0001_init.sql into the SQL editor

# 4. Deploy the AI edge function + its secret
supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
supabase functions deploy chat

# 5. Run
npm run dev                      # http://localhost:5173
```

Then sign up, and start chatting.

> **Tip for first-run testing:** in Supabase → Authentication → Providers → Email, you can turn off **"Confirm email"** so password signups log in immediately (the built-in email sender is rate-limited).

## Environment variables

| Where | Variable | Notes |
| --- | --- | --- |
| Frontend (build-time) | `VITE_SUPABASE_URL` | Your Supabase project URL. Inlined into the bundle. |
| Frontend (build-time) | `VITE_SUPABASE_ANON_KEY` | Anon/publishable key. Safe in the browser — RLS protects data. |
| Edge function secret | `ANTHROPIC_API_KEY` | **Server-only.** `supabase secrets set ANTHROPIC_API_KEY=…` |
| Edge function secret | `ANTHROPIC_MODEL` | Optional. Defaults to `claude-opus-4-8`. |
| Edge function secret | `ANTHROPIC_EFFORT` | Optional. `low` \| `medium` \| `high`. Defaults to `medium`. |

`VITE_*` vars are read at **build time** — on a host like Railway they must be set before the build runs.

## Deploying

Two pieces go live: the **Supabase backend** (schema, auth, storage, realtime, the `chat` function) and the **static frontend**. Railway is wired up out of the box:

1. Railway → **New Project → Deploy from GitHub repo** → this repo, `main`.
2. Add service variables `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`.
3. Deploy. Railway runs `npm install` → `npm run build` → `npm run start` (serves `dist/` with SPA fallback).
4. Add your deployed URL to Supabase **Authentication → URL Configuration** (Site URL + Redirect URLs) so email/magic-link redirects land back on your app.

Full details — including the Site URL gotcha — are in [`DEPLOY.md`](./DEPLOY.md).

## Security model

- The browser only ever holds the **anon/publishable** key. Row-level security is what protects data, not key secrecy. Every table has RLS: owners see their own rows; artifacts/files open up only when explicitly set to *unlisted* or *public*.
- Files live in a **private** storage bucket scoped to `‹user-id›/…`; sharing is done with time-limited signed URLs.
- The **Anthropic key** is only ever a Supabase Edge Function secret — never in the repo, never in the bundle.
- The `chat` function requires a valid Supabase JWT (`verify_jwt`), so only signed-in users can call the model.

## Regenerating types

After changing the schema, refresh the typed client:

```bash
npm run gen:types        # supabase gen types typescript --linked > src/lib/database.types.ts
```

## Roadmap

This is a foundation meant to grow. Conversations and artifacts are the natural seeds for:

- ⏱️ **Scheduled agents** — promote a useful chat/artifact into a recurring job.
- 🪝 **Webhooks** — trigger workflows from outside, or call out when something happens.
- 👥 **Team sharing & spaces** — shared workspaces, roles, comments.
- 🧩 **Richer artifacts** — versions, attachments, embeds.

Issues and PRs welcome.

## Contributing

1. Fork and clone.
2. `npm install`, then follow **Quick start** to point at your own Supabase project.
3. `npm run build` (typecheck + build) and `npm run lint` should pass.
4. Open a PR with a clear description.

## License

MIT — see [`LICENSE`](./LICENSE). Use it, fork it, build your own intranet.
