# Intranet

A friendly, React-based intranet layer on top of [Supabase](https://supabase.com). Log in, chat with an AI assistant to build things, and share what you make — publicly or locked down. Files, artifacts, and live updates included.

It leans on Supabase for everything that should be "boring and solid":

- **Auth** — email/password and magic links via Supabase Auth.
- **Data + security** — Postgres with row-level security; you only ever see your own rows unless something is explicitly shared.
- **Realtime** — chat messages stream in over websockets, so a conversation stays in sync across devices.
- **Storage** — private file bucket with owner-scoped access and signed share links.
- **AI** — a Supabase Edge Function calls Claude server-side (your API key never reaches the browser) and streams the response.

## Features

| Area | What you get |
| --- | --- |
| 💬 **Chat** | Conversations with an AI assistant. Responses stream token-by-token and persist to the database; realtime keeps every device in sync. |
| 📄 **Artifacts** | Turn any reply (or a blank page) into a document/code/HTML artifact. Edit with live preview, then set it **Private**, **Unlisted** (link only), or **Public**. |
| 📁 **Files** | Upload files to a private bucket. Generate a 7-day signed share link when you want to hand one out. |
| 🔐 **Auth + profiles** | Sign up / sign in, edit your display name. A profile row is created automatically on signup. |

This is a foundation meant to grow: artifacts and conversations are the natural seeds for **scheduled agents, promotable workflows, and webhooks** down the line.

## Tech stack

- **Frontend:** React 18 + TypeScript + Vite + Tailwind CSS + React Router
- **Backend:** Supabase (Postgres, Auth, Realtime, Storage, Edge Functions)
- **AI:** Anthropic Claude (`claude-opus-4-8`) via a Deno edge function

## Project layout

```
src/
  contexts/AuthContext.tsx     Supabase Auth wrapper (session, sign in/up/out)
  components/                  Layout, nav, markdown, sharing controls, icons
  pages/                       Login, Chat, Artifacts, Artifact editor,
                               Public artifact, Files, Settings
  lib/                         Supabase client, chat streaming, types, utils
supabase/
  migrations/0001_init.sql     Schema + RLS + realtime + storage policies
  functions/chat/index.ts      Edge function that streams Claude
```

## Getting started

### 1. Install

```bash
npm install
```

### 2. Point at your Supabase project

```bash
cp .env.example .env.local
```

Fill in `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` (Project Settings → API).

### 3. Apply the schema

Either run the SQL in `supabase/migrations/0001_init.sql` from the SQL editor, or with the CLI:

```bash
supabase link --project-ref <your-project-ref>
supabase db push
```

### 4. Deploy the AI edge function

```bash
supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
supabase functions deploy chat
```

(Optional secrets: `ANTHROPIC_MODEL`, `ANTHROPIC_EFFORT` = `low` | `medium` | `high`.)

### 5. Run

```bash
npm run dev
```

Open http://localhost:5173, create an account, and start chatting.

## Notes

- The browser only ever holds the **anon/publishable** key. That's safe by design — row-level security is what protects data, not key secrecy.
- The Anthropic key lives only as a Supabase **Edge Function secret**.
- To regenerate `src/lib/database.types.ts` from the live schema: `npm run gen:types`.
