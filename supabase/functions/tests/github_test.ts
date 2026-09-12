import { assert, assertEquals, assertStringIncludes } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import {
  BRIEF_DELIMITER,
  buildRepoDigest,
  buildSyncPrompt,
  commitsToText,
  formatDirListing,
  formatRepoList,
  githubErrorMessage,
  isProbablyTextPath,
  isRepoId,
  issuesToText,
  languagesToText,
  parseRepoRef,
  parseSinceInput,
  pickKeyFiles,
  pullsToText,
  repoArtifactTitle,
  splitSyncOutput,
  summarizeTree,
  syncStatusLabel,
  truncateText,
} from '../_shared/github.ts'

// --- parseRepoRef -----------------------------------------------------------

Deno.test('parseRepoRef accepts the forms people paste', () => {
  const want = { owner: 'alnutile', name: 'supabase-as-a-service', fullName: 'alnutile/supabase-as-a-service' }
  assertEquals(parseRepoRef('https://github.com/alnutile/supabase-as-a-service'), want)
  assertEquals(parseRepoRef('https://github.com/alnutile/supabase-as-a-service/'), want)
  assertEquals(parseRepoRef('https://github.com/alnutile/supabase-as-a-service.git'), want)
  assertEquals(parseRepoRef('https://www.github.com/alnutile/supabase-as-a-service/tree/main/src'), want)
  assertEquals(parseRepoRef('github.com/alnutile/supabase-as-a-service'), want)
  assertEquals(parseRepoRef('git@github.com:alnutile/supabase-as-a-service.git'), want)
  assertEquals(parseRepoRef('alnutile/supabase-as-a-service'), want)
  assertEquals(parseRepoRef('  alnutile/supabase-as-a-service  '), want)
})

Deno.test('parseRepoRef rejects non-repos', () => {
  assertEquals(parseRepoRef(''), null)
  assertEquals(parseRepoRef(undefined), null)
  assertEquals(parseRepoRef('supabase'), null)
  assertEquals(parseRepoRef('https://gitlab.com/owner/name'), null)
  assertEquals(parseRepoRef('https://github.com/owner'), null)
  assertEquals(parseRepoRef('https://gist.github.com/owner/abc123'), null)
  assertEquals(parseRepoRef('owner/na me'), null)
  assertEquals(parseRepoRef('owner/..'), null)
  assertEquals(parseRepoRef('-owner/name'), null)
})

Deno.test('isRepoId recognizes a uuid and nothing else', () => {
  assert(isRepoId('0b6f1e2a-1234-4abc-9def-0123456789ab'))
  assert(!isRepoId('owner/name'))
  assert(!isRepoId(''))
})

Deno.test('repoArtifactTitle is stable across syncs', () => {
  assertEquals(repoArtifactTitle('a/b'), 'Repo: a/b')
})

// --- picking files ----------------------------------------------------------

Deno.test('pickKeyFiles takes known manifests in priority order, case-insensitively, then docs', () => {
  const tree = [
    { path: 'src/index.ts', type: 'blob' },
    { path: 'package.json', type: 'blob' },
    { path: 'readme.md', type: 'blob' },
    { path: 'claude.md', type: 'blob' },
    { path: 'docs/architecture.md', type: 'blob' },
    { path: 'docs/README.md', type: 'blob' },
    { path: 'docs/deep/inner.md', type: 'blob' },
    { path: 'Dockerfile', type: 'blob' },
    { path: 'docs', type: 'tree' },
  ]
  const picked = pickKeyFiles(tree, 10, 3)
  assertEquals(picked, ['claude.md', 'package.json', 'Dockerfile', 'docs/README.md', 'docs/architecture.md'])
  // README itself is fetched separately, never picked here.
  assert(!picked.includes('readme.md'))
  // Nested docs are not top-level docs.
  assert(!picked.includes('docs/deep/inner.md'))
})

Deno.test('pickKeyFiles honours the max', () => {
  const tree = ['CLAUDE.md', 'AGENTS.md', 'package.json', 'go.mod'].map((path) => ({ path, type: 'blob' }))
  assertEquals(pickKeyFiles(tree, 2), ['CLAUDE.md', 'AGENTS.md'])
})

Deno.test('isProbablyTextPath uses extension and well-known basenames', () => {
  assert(isProbablyTextPath('src/app.tsx'))
  assert(isProbablyTextPath('Dockerfile'))
  assert(isProbablyTextPath('config/.env.example'))
  assert(isProbablyTextPath('LICENSE'))
  assert(!isProbablyTextPath('logo.png'))
  assert(!isProbablyTextPath('bundle.wasm'))
  assert(!isProbablyTextPath('bin/tool'))
})

// --- rendering --------------------------------------------------------------

Deno.test('truncateText leaves short text alone and notes a cut', () => {
  assertEquals(truncateText('hello', 10), 'hello')
  const out = truncateText('a'.repeat(100), 40)
  assert(out.length <= 40)
  assertStringIncludes(out, '…(truncated)')
  assertEquals(truncateText('a\r\nb', 10), 'a\nb')
})

Deno.test('summarizeTree reports counts, top-level layout and file types', () => {
  const tree = [
    { path: 'src', type: 'tree' },
    { path: 'src/a.ts', type: 'blob' },
    { path: 'src/b.ts', type: 'blob' },
    { path: 'docs', type: 'tree' },
    { path: 'docs/x.md', type: 'blob' },
    { path: 'package.json', type: 'blob' },
    { path: 'Makefile', type: 'blob' },
  ]
  const out = summarizeTree(tree)
  assertStringIncludes(out, '5 files in 2 directories')
  assertStringIncludes(out, 'src/ (2 files)')
  assertStringIncludes(out, 'docs/ (1 file)')
  assertStringIncludes(out, 'Top-level files: Makefile, package.json')
  assertStringIncludes(out, 'ts 2')
  assertStringIncludes(out, '(none) 1')
  assertStringIncludes(summarizeTree(tree, { truncated: true }), 'truncated by GitHub')
  assertEquals(summarizeTree([]), '(empty tree)')
})

Deno.test('formatDirListing puts directories first and shows sizes', () => {
  const out = formatDirListing('src', [
    { name: 'z.ts', type: 'file', size: 2048 },
    { name: 'lib', type: 'dir' },
    { name: 'a.ts', type: 'file', size: 10 },
  ])
  assertEquals(out.split('\n'), ['lib/', 'a.ts (10 B)', 'z.ts (2.0 KB)'])
  assertEquals(formatDirListing('', []), '/: (empty)')
})

Deno.test('commits / pulls / issues render compactly and cap the list', () => {
  const commits = Array.from({ length: 5 }, (_, i) => ({
    sha: `abcdef${i}1234567`,
    date: '2026-09-01T10:00:00Z',
    message: `Commit ${i}\n\nbody`,
    author: 'alfred',
  }))
  const c = commitsToText(commits, 3)
  assertStringIncludes(c, '- 2026-09-01 abcdef0 Commit 0 (alfred)')
  assert(!c.includes('body'))
  assertStringIncludes(c, '…and 2 more')
  assertEquals(commitsToText([]), '(no commits in this window)')

  const p = pullsToText([{ number: 7, title: 'Add thing', author: 'bo', created_at: '2026-08-30T00:00:00Z', draft: true }])
  assertStringIncludes(p, '- #7 Add thing [draft] (bo, opened 2026-08-30)')
  assertEquals(pullsToText([]), '(no open pull requests)')

  const i = issuesToText([{ number: 9, title: 'Bug', author: 'cy', created_at: '2026-08-01T00:00:00Z', labels: ['bug', 'p1'] }])
  assertStringIncludes(i, '- #9 Bug [bug, p1] (cy, opened 2026-08-01)')
  assertEquals(issuesToText([]), '(no open issues)')
})

Deno.test('languagesToText renders percentages, largest first', () => {
  assertEquals(languagesToText({ TypeScript: 750, PLpgSQL: 250 }), 'TypeScript 75%, PLpgSQL 25%')
  assertEquals(languagesToText(undefined), '')
  assertEquals(languagesToText({}), '')
})

Deno.test('formatRepoList and syncStatusLabel share the status vocabulary', () => {
  const row = {
    id: 'r1',
    full_name: 'a/b',
    description: 'A thing',
    language: 'TypeScript',
    last_sync_status: 'ok',
    last_synced_at: '2026-09-02T12:00:00Z',
    artifact_id: 'art1',
    visibility: 'workspace',
  }
  const out = formatRepoList([row])
  assertStringIncludes(out, '• a/b — A thing')
  assertStringIncludes(out, 'synced 2026-09-02')
  assertStringIncludes(out, 'summary /artifacts/art1')
  assertStringIncludes(out, 'id: r1')
  assertEquals(syncStatusLabel({ last_sync_status: 'idle', last_synced_at: null }), 'never synced')
  assertEquals(syncStatusLabel({ last_sync_status: 'running', last_synced_at: null }), 'syncing')
  assertEquals(syncStatusLabel({ last_sync_status: 'error', last_synced_at: '2026-01-01T00:00:00Z' }), 'last sync failed')
})

// --- the digest --------------------------------------------------------------

function digestInput(over: Partial<Parameters<typeof buildRepoDigest>[0]> = {}) {
  return {
    fullName: 'a/b',
    description: 'desc',
    defaultBranch: 'main',
    language: 'TypeScript',
    topics: ['supabase'],
    readme: '# Hello\nThis is the readme.',
    tree: [{ path: 'src/a.ts', type: 'blob' }],
    keyFiles: [{ path: 'package.json', content: '{"name":"b"}' }],
    commits: [],
    pulls: [],
    issues: [],
    ...over,
  }
}

Deno.test('buildRepoDigest includes every section in order', () => {
  const d = buildRepoDigest(digestInput({ languages: { TypeScript: 1 } }))
  const order = ['## Facts', '## Layout', '## README', '## File: package.json', '## Recent commits', '## Open pull requests', '## Open issues']
  let last = -1
  for (const h of order) {
    const idx = d.indexOf(h)
    assert(idx > last, `${h} should appear after the previous section`)
    last = idx
  }
  assertStringIncludes(d, 'Repository: a/b')
  assertStringIncludes(d, 'Languages: TypeScript 100%')
  assertStringIncludes(d, 'This is the readme.')
})

Deno.test('buildRepoDigest respects the overall budget and says what it dropped', () => {
  const d = buildRepoDigest(
    digestInput({
      readme: 'r'.repeat(5000),
      keyFiles: [
        { path: 'a.md', content: 'a'.repeat(3000) },
        { path: 'b.md', content: 'b'.repeat(3000) },
        { path: 'c.md', content: 'c'.repeat(3000) },
      ],
      budgetChars: 6000,
    }),
  )
  assert(d.length <= 6200, `digest should be near the budget, got ${d.length}`)
  assertStringIncludes(d, 'section(s) omitted')
})

Deno.test('buildRepoDigest skips empty key files and README', () => {
  const d = buildRepoDigest(digestInput({ readme: '   ', keyFiles: [{ path: 'x', content: '' }] }))
  assert(!d.includes('## README'))
  assert(!d.includes('## File: x'))
})

// --- prompt + reply ---------------------------------------------------------

Deno.test('buildSyncPrompt distinguishes a first sync from a revision', () => {
  const first = buildSyncPrompt({ fullName: 'a/b', url: 'https://github.com/a/b', digest: 'D' })
  assertStringIncludes(first.user, 'FIRST sync')
  assert(!first.user.includes('<existing_summary>'))
  assertStringIncludes(first.system, BRIEF_DELIMITER)
  assertStringIncludes(first.system, '## Questions and unknowns')
  assertStringIncludes(first.user, '<repository_material>\nD\n</repository_material>')

  const again = buildSyncPrompt({
    fullName: 'a/b',
    url: 'u',
    digest: 'D',
    existingSummary: '# Old',
    focus: 'billing',
    sinceLabel: '2026-08-01',
    notes: 'our main app',
  })
  assertStringIncludes(again.user, 'RE-SYNC')
  assertStringIncludes(again.user, '<existing_summary>\n# Old\n</existing_summary>')
  assertStringIncludes(again.user, 'Focus for this pass: billing')
  assertStringIncludes(again.user, 'activity since 2026-08-01')
  assertStringIncludes(again.user, 'our main app')
})

Deno.test('splitSyncOutput separates the document from the brief', () => {
  const { summary, brief } = splitSyncOutput(`# Doc\n\nbody\n\n${BRIEF_DELIMITER}\n- new: x\n- changed: y`)
  assertEquals(summary, '# Doc\n\nbody')
  assertEquals(brief, '- new: x\n- changed: y')
})

Deno.test('splitSyncOutput tolerates a fence and a missing delimiter', () => {
  const fenced = splitSyncOutput('```markdown\n# Doc\n' + BRIEF_DELIMITER + '\nbrief\n```')
  assertEquals(fenced.summary, '# Doc')
  assertEquals(fenced.brief, 'brief')
  const plain = splitSyncOutput('# Just a doc')
  assertEquals(plain.summary, '# Just a doc')
  assertEquals(plain.brief, 'Summary compiled.')
})

// --- misc ---------------------------------------------------------------------

Deno.test('githubErrorMessage explains the fix by status and token presence', () => {
  assertStringIncludes(githubErrorMessage(404, false, 'a/b'), 'add a GitHub token')
  assertStringIncludes(githubErrorMessage(404, true, 'a/b'), 'cannot see this repository')
  assertStringIncludes(githubErrorMessage(401, true, 'a/b'), 're-check it')
  assertStringIncludes(githubErrorMessage(403, false, 'a/b'), 'rate limit')
  assertStringIncludes(githubErrorMessage(500, true, 'a/b'), '500')
})

Deno.test('parseSinceInput accepts ISO or a bare day, flags garbage', () => {
  assertEquals(parseSinceInput(undefined), null)
  assertEquals(parseSinceInput(''), null)
  assertEquals(parseSinceInput('2026-09-01'), '2026-09-01T00:00:00.000Z')
  assertEquals(parseSinceInput('2026-09-01T12:30:00Z'), '2026-09-01T12:30:00.000Z')
  assertEquals(parseSinceInput('yesterday'), 'invalid')
})
