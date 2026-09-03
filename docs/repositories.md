# Repositories (GitHub)

Connect the company's GitHub repositories so the workspace can **read the code
and remember what it learns**. Each connected repository gets ONE maintained
summary artifact: what the product is, who it is for, how it is built, the key
areas of the codebase, what the team is working on right now, and the open
work. Chat, agents and collections draw on that artifact, so the assistant
understands what the company builds instead of guessing from a name.

The feature is a memory layer, not a code browser. The artifact is the answer;
the repository is the evidence behind it, and `browse_repository` is the
fallback for a specific question the summary does not cover (the same
compiled-first discipline as the knowledge compiler).

## Setup

1. **Optional but recommended:** an admin adds a GitHub token in
   **Settings → GitHub**. Public repositories work without one (GitHub's
   anonymous limit of 60 requests an hour); private repositories, and any real
   volume, need it. A fine-grained token with read-only `Contents`,
   `Metadata`, `Pull requests` and `Issues` on the chosen repositories is
   enough. A classic token with the `repo` scope also works. The token lives
   only in Supabase Vault (`set_github_integration` writes it,
   `read_github_secret` is service-role-only, nothing returns it to a browser).
2. Open **Assets → Repositories**, paste a GitHub URL or `owner/name`, press
   Enter. The row is created through the `add_repository` builtin (metadata is
   fetched server-side) and the first sync starts immediately.
3. When the sync finishes the card shows **Synced …**, links to the summary
   artifact, a **Chat** button (opens Chat with the summary beside the thread)
   and a collapsible **What changed last sync** brief.

## Keeping it current

- **Re-sync** any card (the loop button) or say it in chat: *"update the
  summary for acme/billing-api with the latest news"*. The assistant calls
  `sync_repository`, which re-reads the repo and **revises the existing
  artifact in place** (it never mints a second one) and returns a change brief.
- **Focused pass:** the pencil button opens notes plus a *re-sync with a focus*
  field ("how authentication works", "the payments module"). The focus is
  passed to the model for that pass.
- **Notes:** the "why this repo matters" note is human-written and is handed to
  the model every sync, so "this is the customer-facing app" shapes the summary.
- **Schedule it:** a nightly refresh is an ordinary agent scoped to
  `sync_repository` on a `schedules` row (or a `repository.created` listener
  that syncs new repos).
- **React to it:** every pass emits a `repository.synced` event (with the
  change brief in `data.summary`), so a listener can post the brief to Slack or
  file it somewhere.

## What a sync reads

Per pass, with the workspace token when present:

| Source | Cap |
| --- | --- |
| Repository facts (description, default branch, language, topics, stars, license, homepage) | – |
| Languages breakdown | – |
| Recursive tree → layout summary (top-level dirs with counts, file types) | – |
| README | 14k chars |
| Up to 10 key files: `CLAUDE.md`, `AGENTS.md`, `ARCHITECTURE.md`, `CONTRIBUTING.md`, manifests (`package.json`, `composer.json`, `pyproject.toml`, `go.mod`, `Cargo.toml`, …), Dockerfile / compose, `Makefile`, `ROADMAP.md`, `CHANGELOG.md`, top-level `docs/*.md` | 4k chars each |
| Commits since the last sync (or 90 days on the first pass) | 30 by default, `max_commits` up to 100 |
| Open pull requests, open issues | 15 each |
| Whole digest | ~70k chars |

The orchestrator model writes the document against a fixed outline (what it
is / who it is for / how it is built / key areas / how work happens / current
focus / open work / glossary / questions and unknowns / sources) followed by a
change brief. Repository content is passed as **untrusted material**: the
prompt tells the model that instructions inside a README, an issue or a commit
message are data to summarize, never commands to follow. Model usage is
recorded with context `repository`.

## Access model

- A `repositories` row is `private` (owner + admins) or `workspace` (every
  member can see and re-sync). New rows default to `workspace` because the
  point is a shared picture of what the company builds.
- The summary artifact is owned by the repo's owner. Its visibility follows the
  repo: `workspace` → `unlisted` (members read it over RLS; the URL is a
  secret-URL share like any unlisted artifact), `private` → `private`. Toggling
  the repo's Team/Mine badge updates the artifact too.
- Filing a repo into a collection (`collection_repositories`) also files its
  summary artifact into that collection, and `loadCollectionsContext` folds any
  repo summary into the collection's context even when only the repo row was
  filed. Adding a repo to a workspace collection makes the repo workspace-
  visible (the 0122 propagation rule).
- Builtins run with the service role and re-enforce owner/workspace/admin in
  code, like the link and to-do tools. The token never reaches a browser or a
  model.

## Tools (assistant, agents, MCP, `run-tool`)

| Tool | What it does |
| --- | --- |
| `add_repository` | Connect by URL or `owner/name`; fetches metadata; optional `visibility`, `notes`, `collection`/`collections`. Does not sync. |
| `list_repositories` | The repos you can see, with id, description, language, sync state, summary link. Filter by `collection` / `query`. |
| `get_repository` | Metadata + the summary artifact + GitHub activity since the last sync (or `since`): commits, open PRs, open issues. Read this first when asked about a repo. |
| `browse_repository` | List a directory (`path`, default root) or read one text file (capped at 30k chars). Optional `ref`. |
| `sync_repository` | Read the repo and write/revise the summary artifact; optional `focus`, `max_commits`. Returns the change brief. |
| `add_repository_to_collection` | File a repo (and its summary) into a collection. |

The same names are exposed by the MCP server and are callable from the CLI
(`supanet run sync_repository --repo acme/app`) because they are ordinary
`tools` rows dispatched by `run-tool`.

## Where the code is

- `supabase/migrations/0124_repositories.sql` — token RPCs, `repositories`,
  `collection_repositories`, RLS, realtime, events, the six tool seeds and the
  always-on "Repositories" prompt.
- `supabase/functions/_shared/github.ts` — pure: ref parsing, key-file
  selection, tree/commit/PR/issue rendering, the budgeted digest, the sync
  prompt, reply splitting (`tests/github_test.ts`).
- `supabase/functions/_shared/repositories.ts` — the GitHub client and the six
  builtin handlers; `_shared/collections.ts` injects a collection's repos.
- `src/pages/RepositoriesPage.tsx`, `src/pages/settings/GitHubSettings.tsx`
  (`GitHubCard` in `settings/cards.tsx`), `src/lib/repositories.ts` (run-tool
  client) and the pure `src/lib/repositoryRef.ts` (`repositoryRef.test.ts`).

## Planned

- GitLab / Bitbucket / CodeCommit providers behind the same `provider` column.
- A GitHub webhook target (push → `sync_repository`) so summaries refresh on
  merge instead of on a schedule.
- Per-repository tokens for repos outside the workspace token's reach.
- Compiling repository summaries into knowledge pages (the compiler treating a
  repo as a source kind) and a workspace-level "what we build" profile page.
