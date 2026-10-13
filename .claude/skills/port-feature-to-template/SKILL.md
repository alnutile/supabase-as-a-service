---
name: port-feature-to-template
description: >-
  How to extract a feature from THIS app (supabase-as-a-service) and port it into
  the supabase-vibe-starter GitHub template as a self-contained, buildable skill —
  so a project started from the template can rebuild the feature on its own stack.
  Use whenever the user asks to "port / move / bring / extract" a feature, page,
  edge function, or concept "into the template", "into the starter", "into the vibe
  starter", or "to the template install" — e.g. "port the Collections feature to
  the template", "move the Loops board over", "bring the security scan into the
  starter kit". Follow this instead of ad-hoc copying so every ported feature lands
  in the same shape. The worked example is the `ai-feature-pipeline` skill already
  in the template. Triggers: "port to template", "move to the starter", "extract
  feature into vibe-starter", "bring X into the template install".
---

# Port a feature from this app into the vibe-starter template

The goal each time: take one feature out of this production app and drop it into the
**supabase-vibe-starter** template as a **new `.claude/skills/<feature>/` skill** the
template's AI can build out per-project. You are handing over *concept + security
model + adapted build-spec + verbatim source* — not wiring it live into the app
(unless the user asks). The template stays clean; nothing here is committed unless
the user says so.

## The target

- **Path:** `/Users/alfrednutile/Apps/Videos/supabse-vibecoding-starter`
  (note the typo'd `supabse` — that is the real folder name).
- **What it is:** a deliberately minimal React + Vite + TS + Supabase starter — a
  "stack smoke-test" (auth + `documents` table + RLS + realtime + private Storage).
- **What it does NOT have** (so you must adapt, not copy): no `react-router`, no
  tailwind (plain CSS in `src/index.css`), no `AuthContext` (App switches on
  `session`), no admin/roles, no Vault, no `activity_log`, no edge functions yet.
- Read `references/target-conventions.md` for the exact conventions + the
  source→target adaptation map before writing any code.

## The method (what worked, do it again)

1. **Map the feature's full surface in THIS repo.** A feature is rarely one file.
   Grep for it and enumerate: the UI page(s) (`src/pages/*`), pure logic + tests
   (`src/lib/*.ts` + `*.test.ts`), the edge function(s) (`supabase/functions/*`),
   migration(s) (`supabase/migrations/*`), any GitHub workflow, and the wiring
   (`supabase/config.toml`, `src/App.tsx` route, `src/lib/nav.ts`). The feature is
   often documented in `CLAUDE.md` — read that section first.

2. **Capture the concept + the security model.** The most valuable part to hand
   over is *why it's built this way* — the trust boundary, what's owner-only vs
   workspace vs admin, what's attacker-reachable, what fails open vs closed. Write
   this as prose, not code.

3. **List the dependencies and how they map.** For each thing the feature leans on
   (Vault, `profiles.is_admin`, `activity_log`, a storage bucket, realtime, a model
   profile, another builtin), decide: reuse an equivalent in the target, substitute
   a minimal version, or drop it as optional. Record every decision in `ORIGIN.md`.

4. **Package it into the target** at
   `‹target›/.claude/skills/<feature>/`, mirroring the `ai-feature-pipeline` skill:
   - `SKILL.md` — frontmatter (name + description **with trigger phrases**), the
     concept in one screen, the parts table, "read these in order", non-negotiables,
     definition of done.
   - `references/concept.md` — the mental model + security boundary.
   - `references/build-spec.md` — step-by-step build **adapted to the target's
     conventions**, with copy-paste SQL/TS. This is the buildable artifact.
   - `references/<mechanics>.md` — any portable sub-protocol (e.g. an external API
     flow) that's worth isolating from the stack-specific build.
   - `origin-source/` — the real source copied **verbatim** (`cp` from this repo),
     plus `ORIGIN.md` mapping each file to its adapted version and listing what was
     intentionally left behind and why.

5. **Protect the target's green CI** (one-time; already done, but re-verify). Skill
   reference source must not break `npm run lint` / `npm test`:
   - `eslint.config.js` ignores `.claude/**`.
   - `vite.config.ts` scopes `test.include` to `src/**`.
   If a future target lacks these, add them (they're good template hygiene) — see
   `target-conventions.md`.

6. **Verify.** In the target: `npm run typecheck && npm run lint && npm test`
   (and `npm run build`) must be green. Then `git status` the target and report the
   new/changed files — do **not** commit.

7. **Add a one-line discovery pointer** to the target's root `CLAUDE.md` (under
   "Building on top of this starter") so its AI finds the skill, like the
   `ai-feature-pipeline` pointer already there.

## Packaging conventions (keep every ported skill consistent)

- One skill folder per feature, named for the feature (`ai-feature-pipeline`,
  `collections`, `security-scan`…).
- `references/` (plural) = guidance you wrote. `origin-source/` = verbatim source
  you copied. Never name a folder `reference/` (singular) — it collides visually
  with `references/`.
- SKILL.md `description` must contain natural-language **triggers** so the skill
  auto-loads; a skill nobody can find is dead weight.
- The build-spec targets the starter's conventions; keep the untouched original in
  `origin-source/` as ground truth so an AI on a *different* stack can still compare.

## Definition of done

- [ ] The full surface of the source feature is accounted for (nothing silently dropped).
- [ ] Concept + security model written as prose the AI can internalize.
- [ ] `build-spec.md` is copy-paste buildable on the target's conventions.
- [ ] `origin-source/` holds verbatim source + an `ORIGIN.md` adaptation map.
- [ ] Target `typecheck`/`lint`/`test`/`build` are green; `.claude/` stays out of both sweeps.
- [ ] A discovery pointer added to the target `CLAUDE.md`; nothing committed.
