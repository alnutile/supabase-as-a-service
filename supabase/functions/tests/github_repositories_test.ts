import { assertEquals, assertThrows, assertStringIncludes } from 'jsr:@std/assert@1'
import { decodeBlob, eligibleFile, MAX_FILES, normalizePrefix, parseRepository, repositoryContext, selectFiles, type TreeEntry } from '../_shared/github_repositories.ts'
const entry = (path: string, size = 100): TreeEntry => ({ path, size, sha: path, mode: '100644', type: 'blob' })
Deno.test('repository inputs only address github.com repositories', () => {
  assertEquals(parseRepository('https://github.com/Org/Repo.git/'), 'org/repo')
  for (const value of ['https://evil.test/org/repo', 'org/repo/tree/main', 'org/..', 'org/repo?token=x', 'git@github.com:org/repo']) assertThrows(() => parseRepository(value))
  assertEquals(normalizePrefix('/services/api/'), 'services/api')
  assertThrows(() => normalizePrefix('../secrets'))
})
Deno.test('imports reject secrets, generated files, symlinks and large/binary files', () => {
  for (const path of ['.env', '.env.production', 'x/.env.local', 'credentials.json', 'x/secrets.yaml', 'key.pem', 'node_modules/x.js', 'vendor/app.php', 'dist/app.js', 'package-lock.json', 'pnpm-lock.yaml', 'app.min.js', 'image.png']) {
    assertEquals(eligibleFile(entry(path)), false, path)
  }
  assertEquals(eligibleFile(entry('src/main.ts')), true)
  assertEquals(eligibleFile(entry('README')), true)
  assertEquals(eligibleFile(entry('go.mod')), true)
  assertEquals(eligibleFile(entry('src/main.ts', 60001)), false)
  assertEquals(eligibleFile({ ...entry('src/link.ts'), mode: '120000' }), false)
  assertEquals(eligibleFile(entry('services/api/main.ts'), 'services/api'), true)
  assertEquals(eligibleFile(entry('services/api-other/main.ts'), 'services/api'), false)
})
Deno.test('selection is bounded and prioritizes architecture documentation', () => {
  const many = Array.from({ length: 200 }, (_, i) => entry(`src/${i}.ts`))
  const selected = selectFiles([...many, entry('README.md')])
  assertEquals(selected.length, MAX_FILES)
  assertEquals(selected[0].path, 'README.md')
  assertEquals(selectFiles(many.map(f => ({ ...f, size: 60000 }))).length, 16)
})
Deno.test('blob decoding preserves unicode and rejects binaries', () => {
  assertEquals(decodeBlob(btoa('hello\nworld')), 'hello\nworld')
  assertEquals(decodeBlob(btoa('a\0b')), null)
  assertEquals(decodeBlob(btoa(String.fromCharCode(255))), null)
})
Deno.test('context is bounded, includes provenance, and ranks relevant files', () => {
  const text = repositoryContext({ repository: 'org/repo', branch: 'main', commit_sha: 'abc123', synced_at: '2026-09-24', status: 'error', omitted_count: 12,
    files: [{ path: 'src/unrelated.ts', sha: 'a', content: 'x'.repeat(60000) }, { path: 'src/billing.ts', sha: 'b', content: 'function calculateInvoice() { return 42 }' }] }, 'billing invoice', 2000)
  assertEquals(text.length <= 2000, true)
  assertStringIncludes(text, 'commit: abc123')
  assertStringIncludes(text, '12 files excluded')
  assertStringIncludes(text, 'calculateInvoice')
  assertStringIncludes(text, 'status: error')
  assertStringIncludes(text, 'not instructions')
})
