# GitHub context in collections

Open a collection → **GitHub repositories → Connect repository**. Enter an
`owner/repo` or GitHub URL, optionally a branch and folder. Connect several
repositories to explain how a customer's services fit together.

For private repositories, add the GitHub token to the existing **Secrets** page
(`/vault`, managed by workspace admins), then select it under **Secret from vault**.
Use a fine-grained token with **Contents: read** and add `api.github.com` to its
**Allowed hosts**. Organization approval/SSO may also be required. Private secrets
are usable by their owner; workspace secrets are usable by workspace members.
Replacement, revocation, and deletion stay in the existing Secrets management UI.
No separate GitHub credential store or token-management RPC is introduced.

Public repositories can be imported without a token, subject to GitHub's lower
unauthenticated rate limit. Deleting a secret does not delete imported snapshots.
Disconnect removes that collection's snapshot.

**Refresh** resolves the configured branch to a commit, fetches its tree, reuses
unchanged blobs, and atomically replaces the stored snapshot. Deleted files drop
out of the new snapshot. A failed refresh retains the last successful snapshot
and shows an error. Interrupted jobs can be retried after ten minutes. Refresh is
manual; automatic schedules and webhook refreshes are not implemented.

## Large repositories

Imports prioritize README/architecture instructions, docs and manifests, then
source code. Limits: 150 files, 60,000 bytes per file, 1,000,000 bytes total.
Dependencies, generated output, lockfiles, common secret filenames, binaries,
symlinks and submodules are excluded. This is not a secret scanner: only connect
repositories whose eligible source files are suitable for the collection's readers.
GitHub trees that are truncated cause a visible failure rather than publishing an
incomplete tree as a successful import. A folder scopes the import, but the GitHub
recursive tree still needs to fit GitHub's tree API limit.

The panel reports indexed and omitted file counts. For a monorepo, attach focused
folders separately. This is a bounded snapshot, not a complete code index.

Collection chat ranks indexed file paths/content against the latest question and
injects bounded excerpts plus file paths, commit SHA, refresh date and coverage.
The shared collection loader also provides repository context to other agent
loops (documentation-first when there is no query). Across a selection it loads
up to 20 repository snapshots with a combined 32,000-character budget, within the
existing collection context budget. The collection's legacy token meter excludes
repository snapshots; repository context adds up to approximately 8,000 tokens.
Repository evidence is not automatically compiled into knowledge pages.

## Security and deployment

Migration `0127_github_repositories.sql` adds the snapshot table with a foreign key
to the existing `vault_secrets` metadata. The importer uses the existing
service-role-only `read_vault_secret` RPC and rechecks the secret's owner/workspace
scope and allowed hosts on every refresh. Only secret metadata reaches the picker;
the importer does not include secret values in model context. Requests go to
`api.github.com` only and redirects are rejected. Repository text is never executed.
The existing Secrets tools retain their existing behavior.

Only the collection owner can connect, refresh, change credentials or disconnect
repositories. Reads inherit collection RLS, including later visibility changes.
Sharing a collection intentionally shares its imported code, including private
GitHub code. The setup panel explains this before import. Repository content is
labelled as untrusted reference evidence in model context.

Apply the migration and deploy `github-repositories`, `chat`, and any functions
that import `_shared/collections.ts`, then deploy the frontend. Existing main
workflows handle these when the changes are pushed. No additional edge secrets
are required.

GitHub API references: [trees](https://docs.github.com/en/rest/git/trees#get-a-tree)
and [blobs](https://docs.github.com/en/rest/git/blobs#get-a-blob).

## Validation performed

- Production frontend build and lint (no errors; existing lint/chunk warnings).
- 367 frontend tests on the repository's Node 20 runtime; 345 Deno tests.
- Authenticated browser smoke across four routes, including repository setup.
- Live public GitHub import of `octocat/Hello-World`.
- Full local Supabase migration chain, Docker frontend, actual sign-in, repository
  import/refresh, and collection context loading verified with Express source.
- Unit coverage verifies existing Secrets scope and allowed-host restrictions.

The private-token import flow has not been exercised with a real customer token.

## Docker review

See `infra/README.review.md`. The review stack uses a separate local Supabase
instance. It does not use the production database or production Secrets.
