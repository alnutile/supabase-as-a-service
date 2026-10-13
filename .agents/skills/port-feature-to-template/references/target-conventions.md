# Target conventions + source→target adaptation map

Everything you need to know about **supabase-vibe-starter** to adapt a feature to
it. Re-read the target's own `CLAUDE.md` and `.claude/skills/vibe-coding-with-confidence/`
if anything here looks stale — the template is the source of truth for itself.

## The target at a glance

| Concern | Target (supabase-vibe-starter) | This app (supabase-as-a-service) |
|---|---|---|
| Routing | **None** — `App.tsx` renders `<Auth/>` or `<Dashboard/>` on `session`. Add views as tabs/conditionals. | `react-router-dom`, routes in `App.tsx`, nav in `src/lib/nav.ts` |
| Styling | **Plain CSS** in `src/index.css` (classes: `page`, `header`, `btn`, `card`, `muted`, `list`, `link`, `danger`, `error`, `center`, `small`) | Tailwind + design tokens (`bg-primary`, `text-muted`, `border-border`, …) |
| Current user | `session` prop (`session.user.id`, `.email`) passed down from `App` | `useAuth()` from `src/contexts/AuthContext` |
| Icons | inline text / add your own SVG | `src/components/icons.tsx` |
| Migrations | **Timestamp prefix** `YYYYMMDDHHMMSS_name.sql` | Numeric prefix `0048_name.sql` (contiguous) |
| Data-model default | the `documents` shape: `user_id default auth.uid()`, RLS ON, 4 owner-gated policies, `updated_at` trigger, added to realtime publication | varies; owner-only or private/workspace `visibility` |
| Server secrets | **edge-function secrets** (`supabase secrets set X=…`) | Supabase **Vault** (`vault_secrets`, `read_vault_secret` RPC) |
| Roles | **none** (open sign-up) | `profiles.is_admin` (first signup admin, invite-only) |
| Audit log | **none** | `activity_log` (+ `events`/listeners) |
| Storage | one private bucket `documents`, objects under `‹uid›/…`, signed URLs | `files` bucket (+ others), same folder-scoped RLS |
| Edge functions | **none yet** — you create `supabase/functions/<name>/` and register in `config.toml` | many, `_shared/` helpers, model profiles |
| CI | `.github/workflows/ci.yml`: `typecheck` → `lint` → `test` → `build` | lint + build + vitest + deno tests |
| Deploy | Railway from `main` on push; `supabase-migrations.yml` | Railway + deploy-migrations + deploy-functions |

## Standard substitutions (apply these when adapting)

- **`react-router` route** → a tab/conditional view rendered from `Dashboard` or
  `App` keyed off local state. (If the target later adds a router, switch to a route.)
- **Tailwind classes** → plain CSS classes; add feature-specific rules to
  `src/index.css` (see the `ai-feature-pipeline` build-spec §4 for the pattern).
- **`useAuth()`** → accept `session` as a prop; `session.user.id` / `session.user.email`.
- **`src/lib/icons`** → drop the icon or inline a small SVG.
- **Vault (`read_vault_secret`)** → `Deno.env.get('SECRET_NAME')` from an edge
  secret. Note the vault gives per-workspace, audited secrets; call that out as the
  production upgrade in `ORIGIN.md`.
- **`profiles.is_admin` (full system)** → the minimal first-signup-is-admin
  `profiles` table (see `ai-feature-pipeline` build-spec §1a). Enforce the gate
  **in the edge function in code**, not just by hiding UI.
- **`activity_log` inserts** → drop them, or note "add back when the target grows
  an audit log." Don't fake a table the target doesn't have.
- **Numeric migration prefix** → a timestamp after the target's latest migration;
  fold small follow-on migrations (e.g. a realtime `alter publication`) into the
  main one rather than shipping a second file.
- **`_shared/` helpers** → inline what the feature needs into its own function, or
  copy the specific helper into the skill's `origin-source/` and reference it.

## CI hygiene (do this on any target that ships skills)

Skill `origin-source/` holds real `.ts/.tsx` that will otherwise be linted and
tested by the app's own tooling and can break green CI (e.g. `no-explicit-any`
errors, stray collected tests). Keep `.claude/` out of both sweeps:

```js
// eslint.config.js — flat config
{ ignores: ['dist', '.claude/**'] }
```
```ts
// vite.config.ts — test block
test: { include: ['src/**/*.{test,spec}.{ts,tsx}'], /* …existing… */ }
```

Then verify: `npm run typecheck && npm run lint && npm test && npm run build`.

## Copying source verbatim

Use `cp` from this repo into the skill's `origin-source/`. Rename an edge function's
`index.ts` to something legible (`<feature>.function.index.ts`) so multiple copied
files don't collide. Always add `ORIGIN.md` mapping each copied file → origin path →
"adapt for the target" note, and a "left behind" section for origin-only infra.

## The exemplar

`‹target›/.claude/skills/ai-feature-pipeline/` is the first feature ported this way.
Copy its shape: `SKILL.md` + `references/{concept,github-flow,build-spec}.md` +
`origin-source/{…verbatim…, ORIGIN.md}`. When in doubt, match it.
