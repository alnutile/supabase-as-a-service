---
name: feature-build-pipeline
description: >-
  How to build (or replicate into another system) a "suggest a feature → AI builds
  it → it ships to production" pipeline. A kanban board whose lane moves are the
  approvals: an idea becomes a GitHub issue, a Claude Code GitHub Action implements
  it on a branch and opens a PR, and merging the PR deploys to production. Use this
  whenever the user wants to stand up a feature-request / self-improvement pipeline
  backed by GitHub Issues + Actions, port the existing Features board to another
  repo or product, wire lane/status changes to GitHub Actions, or understand how
  approvals map to "open an issue" and "merge a PR". Covers the data model, the
  four lanes, the edge function that talks to GitHub, the build workflow, the deploy
  workflows, and the exact secrets/labels/keys you must configure.
---

# Feature-request → AI build → deploy pipeline

This is a **self-improvement pipeline as a kanban board**. Non-technical people file
ideas; dragging a card between lanes is the *approval*; the approvals drive GitHub
Issues + Actions; and merging the resulting PR is what deploys to production. No one
writes code by hand and no AI ever pushes to `main` — a human PR review sits between
"anyone can type a feature request" and "code runs in production."

Use this skill two ways:
1. **To operate** the pipeline in this repo (`alnutile/supabase-as-a-service`).
2. **To port it** to another product/repo — the `reference/` files are a working
   blueprint with the repo-specific bits marked. Follow the **Porting checklist** at
   the bottom.

## The mental model: lanes are approvals

Four lanes. Two of the three transitions have side effects (they touch GitHub); the
rest are plain metadata edits to the board.

| Lane | Meaning | Moving a card *into* it does… |
| --- | --- | --- |
| **idea** | Anyone on the team files it (title, description, optional screenshots). | Nothing external. Just a row. |
| **approved** ("Approved for work") | An **admin** decided it's worth AI effort. | Opens a **GitHub issue** labeled `approved-for-work`. That label fires the build Action, which implements the feature on a branch and opens a **PR** referencing the issue. The PR is tracked back on the card. |
| **ready** ("Approved to merge") | An **admin** reviewed the PR and wants to ship. | **Squash-merges the PR.** Merging `main` *is* deploying. |
| **shipped** | The PR merged. | Nothing — this is the terminal state the sync sets automatically once the PR shows as merged. |

The security boundary is the PR review. Feature text is attacker-reachable (anyone
who can file an idea controls what the coding agent reads), so the agent runs on a
branch and **cannot push to `main`**. A human approves twice: once to spend AI effort
(idea→approved), once to ship (→ready/merge).

## The four moving parts

```
   Board UI                Edge function              GitHub                    Deploy
 (kanban page)     ─────►   (features fn)     ─────►  Issues + Actions   ─────► prod
  drag a card              approve/sync/merge         claude-feature.yml        (Railway +
  = approval               (talks to GH API)          builds PR                  deploy-*.yml)
```

1. **A board + table** — `features` table (one row per idea) and a kanban UI. The UI
   does plain edits directly; side-effect moves call the edge function.
   → `reference/0048_features_board.sql`, `reference/FeaturesPage.tsx`
2. **An edge function that talks to GitHub** — `approve` opens an issue, `sync`
   refreshes the linked PR's state, `merge` squash-merges. Admin-gated; the GitHub
   token lives only in the vault. → `reference/features-function.ts`
3. **A build GitHub Action** — fires on the `approved-for-work` label, runs Claude
   Code against a checkout, opens a PR that `Closes #<issue>`, and runs the test suite
   on the branch (because bot-opened PRs don't trigger the normal PR workflow).
   → `reference/claude-feature.yml`
4. **Deploy workflows** — merging `main` auto-deploys the frontend (Railway) and, via
   two workflows, applies DB migrations and redeploys edge functions.
   → `reference/deploy-migrations.yml`, `reference/deploy-functions.yml`

### 1. The data model (`features` table)

A `features` row carries the idea plus the GitHub state synced back onto it:
`lane`, `issue_number`, `pr_number`, `pr_url`, `pr_state` (`open|merged|closed`),
`last_error` (surfaced on the card). RLS: anyone signed in reads and files ideas;
**lane moves + edits are admin-only** (except the owner may edit/delete their *own*
card while it's still an `idea`, i.e. before any GitHub side effects exist). Put the
table in the realtime publication so the PR link/state lands on the card live once the
function syncs it. Full DDL + policies: `reference/0048_features_board.sql`.

### 2. The edge function (`features`)

`POST { action, id }`, `verify_jwt: true`, then **re-checks `profiles.is_admin` in
code** (the function runs as the service role). Reads the GitHub PAT from the vault
secret `github_pat` — never a column, never a client payload, never a log.

- **approve** → creates a GitHub issue (title = card title; body = description + short
  24h-signed screenshot URLs + a `<!-- feature:<id> -->` marker) labeled
  `approved-for-work`; stores `issue_number` on the row; logs `feature.approved`.
- **sync** → finds the PR that cross-references the issue (via the issue *timeline*),
  reads the PR, writes back `pr_number/pr_url/pr_state`; a merged PR flips the lane to
  `shipped`.
- **merge** → syncs first, then squash-merges the linked PR; logs `feature.shipped`.

Full source: `reference/features-function.ts`. It's the only place that needs the
GitHub API, so if you're porting to a non-Supabase backend this is the file to rewrite
in your stack (an Express route, a Next.js API handler, a Lambda — same three actions).

### 3. The build Action (`claude-feature.yml`)

The heart of "AI builds it." Triggered `on: issues: [labeled]`, gated to
`github.event.label.name == 'approved-for-work'`. Steps:

1. Checkout (full history).
2. **`anthropics/claude-code-action@v1`** with a prompt that passes the issue title +
   body and instructs the agent to: read `CLAUDE.md`, work on branch
   `feature/issue-<n>`, run `npm install` + `npm run build` + `npm test`, add a
   migration if needed, commit, push, and open a PR whose description contains
   `Closes #<n>` — **never push to main, never merge**.
3. **Verify a PR was opened** — green must mean "a PR exists," not "the agent didn't
   crash." If no open PR for the branch, comment on the issue and fail.
4. **Re-run the test suite on the branch** — bot PRs opened with `GITHUB_TOKEN` don't
   trigger `pull_request` workflows (GitHub anti-recursion), so lint/build/test run
   here deterministically against the pushed branch.

**Model routing gotcha (important, copy exactly):** Claude Code is routed through
**OpenRouter's Anthropic-compatible endpoint** so the build bills to OpenRouter, not
an Anthropic key. The action's pre-flight rejects an empty `anthropic_api_key`, but
Claude Code prefers `ANTHROPIC_AUTH_TOKEN` (Bearer) over the api key (X-Api-Key), and
OpenRouter wants Bearer — so pass the OpenRouter key as **both**:

```yaml
env:
  GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}          # gh CLI reads GH_TOKEN; without it `gh pr create` fails silently
  ANTHROPIC_BASE_URL: https://openrouter.ai/api
  ANTHROPIC_AUTH_TOKEN: ${{ secrets.OPEN_ROUTER_KEY }}
with:
  anthropic_api_key: ${{ secrets.OPEN_ROUTER_KEY }}
  github_token: ${{ secrets.GITHUB_TOKEN }}
  claude_args: --model anthropic/claude-sonnet-4.5 --max-turns 150 --allowedTools "Bash(git:*),Bash(npm:*),Bash(gh:*),Read,Write,Edit,Glob,Grep"
```

Full workflow: `reference/claude-feature.yml`.

### 4. Deploy = merge

Merging the PR into `main` is the deploy. Three things watch `main`:
- **Frontend** — the host (Railway here) auto-rebuilds on push to `main`.
- **`deploy-migrations.yml`** — runs `supabase db push` when
  `supabase/migrations/**` changes. Needs `SUPABASE_ACCESS_TOKEN` **and**
  `SUPABASE_DB_PASSWORD` (db push connects straight to Postgres).
- **`deploy-functions.yml`** — runs `supabase functions deploy` when
  `supabase/functions/**` or `config.toml` changes. Needs `SUPABASE_ACCESS_TOKEN` +
  `SUPABASE_PROJECT_REF`.

So the full loop closes back to production automatically: approve → issue → Action
builds PR → review → merge → migrations/functions/frontend redeploy. References:
`reference/deploy-migrations.yml`, `reference/deploy-functions.yml`.

## Everything you must configure (this repo or a new one)

**GitHub repo → Settings → Secrets and variables → Actions:**

| Secret | What it is | Used by |
| --- | --- | --- |
| `OPEN_ROUTER_KEY` | OpenRouter API key (`sk-or-…`). Bills the AI build. | `claude-feature.yml` |
| `SUPABASE_ACCESS_TOKEN` | Supabase PAT. | deploy-migrations / deploy-functions |
| `SUPABASE_DB_PASSWORD` | Postgres password for `db push`. | deploy-migrations |
| `SUPABASE_PROJECT_REF` | Project ref (can be a repo *variable*). | deploy-functions (+ migrations default) |

`GITHUB_TOKEN` is provided automatically by Actions — no setup.

**Workspace vault (in the app, via Secrets/Vault):**
- `github_pat` — a GitHub token with **repo** scope (issues: write, pull_requests:
  write, contents: read). The `features` edge function reads it to open issues and
  merge PRs.

**GitHub label:** create the `approved-for-work` label (any color). This exact string
is the trigger — the edge function applies it; the Action fires on it.

**Branch protection (strongly recommended):** protect `main` so nothing can push
directly — the agent works only via PRs, and the merge lane is the sole path to `main`.

**Edge-function env:** `GITHUB_REPO` (defaults to `owner/repo`; set it when porting)
and standard `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY`.

## Watching the work happen

- The board auto-syncs in-flight cards on open and subscribes to the `features` table
  over realtime, so the **PR link + state (`open`/`merged`/`closed`) appear on the card
  live** as the Action progresses. `last_error` renders on the card if approve/merge
  fails.
- On GitHub: the issue's timeline shows the Action run and the linked PR; the PR's
  Checks tab shows the branch tests (lint/build/test + deno tests) that the Action runs
  itself.
- After merge: the frontend redeploys (Railway) and `deploy-migrations` /
  `deploy-functions` runs show migrations/functions going live.

## Porting checklist (moving this to another system)

Hand the other system these `reference/` files and this checklist. Marked
`⟨REPLACE⟩` items are repo/product-specific.

1. **Table + board.** Create a `features` table (`reference/0048_features_board.sql`)
   and a kanban UI (`reference/FeaturesPage.tsx`). Adjust column names/RLS to the
   target's auth model. Add the table to realtime for the live PR link.
2. **Edge function / API route.** Deploy `reference/features-function.ts` (or reimplement
   its 3 actions in the target stack). Set `GITHUB_REPO = ⟨REPLACE owner/repo⟩`. Store the
   GitHub PAT wherever that stack keeps secrets (vault/env), not in a column.
3. **Build workflow.** Copy `reference/claude-feature.yml` into `.github/workflows/`.
   ⟨REPLACE⟩ the branch-tests step with the target repo's real commands (its
   `npm run build`/`test`, or `pytest`, `go test`, etc.) and the prompt's
   "read CLAUDE.md / conventions" line with the target's conventions doc.
4. **Deploy workflows.** Copy `reference/deploy-migrations.yml` /
   `reference/deploy-functions.yml` **only if** the target is Supabase; otherwise
   replace with that platform's deploy step. Confirm the frontend host auto-deploys
   from `main` (or add a deploy job).
5. **Secrets + label + branch protection.** Add every row in the tables above, create
   the `approved-for-work` label, protect `main`.
6. **Smoke test.** File an idea → drag to Approved → confirm an issue opens with the
   label → confirm the Action runs and opens a PR → review → drag to Approved-to-merge
   → confirm the merge deploys.

Keep the two invariants when adapting: **the AI only ever opens PRs (never pushes to
`main`)**, and **the label string is the contract** between the "approve" action and
the build workflow — change it in both places or not at all.
