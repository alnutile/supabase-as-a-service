# Task: Model Profiles — name the job, not the model

## Context

Three edge functions each hardcode the model the same way:

- `supabase/functions/chat/index.ts:15`
- `supabase/functions/scheduler/index.ts:7`
- `supabase/functions/webhook/index.ts:9`

all `const MODEL = Deno.env.get('ANTHROPIC_MODEL') ?? 'claude-opus-4-8'`.

**The problem:** upcoming features (guardrails, model routing, per-agent models) need to
say "run this on the cheap model" without baking in *which* cheap model — model names
churn, providers will eventually vary, and admins need one place to manage it.

**The goal:** a **Model Profiles** abstraction. A profile is a named job slot the
workspace assigns a model to (e.g. `orchestrator`, `utility`). Features bind to a
profile **key**; admins re-point the key to a different model in Settings. No feature
ever references a model id directly again.

## Design decisions (already made — don't relitigate)

- Two seeded built-in profiles, keyed by job:
  - `orchestrator` — the main brain: interactive chat, agents, webhook/scheduled runs.
    Seed model: `claude-opus-4-8`.
  - `utility` — cheap + fast: guardrail checks, classification, routine processing.
    Seed model: `claude-haiku-4-5-20251001`. (Nothing consumes it yet; the guardrails
    task is its first customer.)
- The DB row is the source of truth. The `ANTHROPIC_MODEL` env var remains only as a
  fallback when the profile row can't be loaded (resilience, not configuration).
- `provider` column exists but is locked to `'anthropic'` for now — the seam for later,
  not a feature today.
- UI naming: the Settings section is called **Models**; each row is a profile with a
  human description of what it powers.

## Requirements

### 1. Schema (new migration, next number in `supabase/migrations/`)

```sql
create table public.model_profiles (
  id uuid primary key default gen_random_uuid(),
  key text not null unique,          -- machine name features bind to
  name text not null,                -- display name
  description text not null default '',  -- what this profile powers (shown in UI)
  provider text not null default 'anthropic' check (provider in ('anthropic')),
  model text not null,               -- e.g. 'claude-opus-4-8'
  is_builtin boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
```

- RLS: any authenticated user can SELECT; only admins (`profiles.is_admin`) can
  INSERT/UPDATE/DELETE — mirror the `tools` table's admin policies (`0006_tools.sql`).
  Built-in rows must not be deletable (either a delete policy excluding
  `is_builtin = true`, or a BEFORE DELETE trigger — match whichever pattern the repo
  already uses for builtins).
- Seed the two built-in rows above with descriptions, e.g. orchestrator: "Powers chat,
  agents, webhooks and scheduled runs"; utility: "Cheap + fast model for guardrails and
  routine background work."

### 2. Shared resolver for edge functions

- Create `supabase/functions/_shared/models.ts` (the standard Supabase shared-module
  location) exporting something like:

  ```ts
  export async function resolveModel(db, key: 'orchestrator' | 'utility'): Promise<string>
  ```

  Reads `model_profiles` by `key` with the service-role client; on any error or missing
  row, falls back to `Deno.env.get('ANTHROPIC_MODEL') ?? 'claude-opus-4-8'` for
  `orchestrator` and `'claude-haiku-4-5-20251001'` for `utility`. Resolve once per
  request (no caching across requests — admins expect edits to apply immediately, and a
  query per invocation is negligible).
- Replace the hardcoded `MODEL` constant in `chat`, `scheduler`, and `webhook` with
  `await resolveModel(db, 'orchestrator')`. Behavior must be otherwise unchanged
  (thinking config, effort, streaming all stay as they are).

### 3. Settings UI (`src/pages/SettingsPage.tsx`)

- New **Models** card, visible to admins only (the page already has admin-gated
  sections — follow that pattern).
- List the profiles: name, description, and an editable model-id text input per row,
  with save. Free-text input is correct (model ids change faster than any dropdown);
  show the current value and a short hint like "Applied on the next message — no
  redeploy needed."
- No create/delete of profiles in this pass — only editing the model on existing rows.

### 4. Types & docs

- Update `src/lib/database.types.ts` for `model_profiles` (regenerate or hand-edit to
  match the migration, per CLAUDE.md convention).
- CLAUDE.md: note that model selection now resolves through `model_profiles` (keys
  `orchestrator` / `utility`) with env as fallback, and that features must bind to a
  profile key, never a model id.

## Acceptance criteria

1. With no other changes, chat / webhook / scheduled runs behave exactly as before
   (still Opus, still streaming, still adaptive thinking).
2. An admin edits the orchestrator profile's model in Settings → the very next chat
   message uses the new model (verifiable in logs), with no redeploy.
3. A non-admin cannot see the Models card and cannot update `model_profiles` directly
   (RLS blocks it).
4. Deleting/renaming the profile row out from under the system doesn't break chat —
   the env/hardcoded fallback kicks in.
5. `npm run build` and `npm run lint` pass.

## Out of scope (do not build now)

Per-agent model overrides, automatic routing/escalation between profiles, non-Anthropic
providers, custom (non-builtin) profiles in the UI, per-profile effort/thinking
configuration, token/cost tracking.

## Constraints

- RLS is the security boundary; admin gating happens in policies, not just the UI.
- Follow existing migration style (comments, explicit grants/revokes as the repo does).
- Don't change the Anthropic call shape for the orchestrator path — adaptive thinking
  on Opus stays exactly as is (see CLAUDE.md's Anthropic conventions).
