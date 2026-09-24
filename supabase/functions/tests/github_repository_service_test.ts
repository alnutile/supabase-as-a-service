import { assertEquals, assertStringIncludes, assertRejects } from 'jsr:@std/assert@1'
import { handleRepositoryRequest, syncRepository, githubSecret } from '../github-repositories/handler.ts'

Deno.test('unauthenticated requests cannot query repository metadata', async () => {
  let queried = false
  const client = { auth: { getUser: () => ({ data: { user: null }, error: true }) }, from: () => { queried = true } }
  const res = await handleRepositoryRequest(new Request('https://local', { method: 'POST', body: '{}' }), client)
  assertEquals(res.status, 401)
  assertEquals(queried, false)
})
Deno.test('collection readers cannot connect repositories or use owner credentials', async () => {
  let reads = 0
  const query = { select: () => query, eq: () => query, maybeSingle: () => ({ data: { id: 'collection', owner_id: 'someone-else' } }) }
  const client = { auth: { getUser: () => ({ data: { user: { id: 'reader' } }, error: null }) }, from: () => { reads++; return query } }
  const res = await handleRepositoryRequest(new Request('https://local', { method: 'POST', body: JSON.stringify({ action: 'add', collection_id: 'collection' }) }), client)
  assertEquals(res.status, 403)
  assertEquals(reads, 1)
})
Deno.test('GitHub failures preserve the snapshot and redact server response bodies', async () => {
  const original = globalThis.fetch
  const writes: Record<string, unknown>[] = []
  const filters: unknown[][] = []
  const client = { from: () => ({ update: (value: Record<string, unknown>) => {
    writes.push(value)
    const query = { eq: (...args: unknown[]) => { filters.push(args); return query }, then: (resolve: (v: unknown) => void) => resolve({ error: null }) }
    return query
  } }) }
  globalThis.fetch = () => Promise.resolve(new Response('sensitive upstream response', { status: 403 }))
  try {
    await syncRepository(client, { id: 'r', repository: 'org/repo', files: [{ path: 'old.ts', content: 'keep' }] }, 'run-1')
    assertEquals(writes.length, 1)
    assertEquals(writes[0].status, 'error')
    assertEquals('files' in writes[0], false)
    assertEquals(String(writes[0].error).includes('sensitive'), false)
    assertEquals(filters, [['id', 'r'], ['run_id', 'run-1']])
  } finally { globalThis.fetch = original }
})
Deno.test('refresh reuses unchanged blobs and removes deleted files in one snapshot write', async () => {
  const original = globalThis.fetch
  const requests: string[] = []
  const writes: Record<string, unknown>[] = []
  const client = { from: () => ({ update: (value: Record<string, unknown>) => {
    writes.push(value)
    const query = { eq: () => query, then: (resolve: (v: unknown) => void) => resolve({ error: null }) }
    return query
  } }) }
  globalThis.fetch = (input) => {
    const url = String(input); requests.push(url)
    const data = url.includes('/git/trees/') ? { tree: [
      { path: 'README.md', sha: 'same', type: 'blob', mode: '100644', size: 5 },
      { path: 'src/new.ts', sha: 'new', type: 'blob', mode: '100644', size: 3 },
    ], truncated: false } : url.includes('/commits/') ? { sha: 'commit', commit: { tree: { sha: 'tree' } } }
      : url.includes('/git/blobs/') ? { encoding: 'base64', content: btoa('new') } : { default_branch: 'main' }
    return Promise.resolve(Response.json(data))
  }
  try {
    await syncRepository(client, { id: 'r', repository: 'org/repo', branch: '', path_prefix: '', files: [
      { path: 'README.md', sha: 'same', content: 'hello' }, { path: 'removed.ts', sha: 'old', content: 'removed' },
    ] }, 'run')
    assertEquals(writes.length, 1)
    assertEquals(writes[0].status, 'ready')
    assertEquals(writes[0].files, [{ path: 'README.md', sha: 'same', content: 'hello' }, { path: 'src/new.ts', sha: 'new', content: 'new' }])
    assertEquals(requests.filter(r => r.includes('/git/blobs/')).length, 1)
    assertStringIncludes(requests.find(r => r.includes('/git/trees/'))!, '/tree?recursive=1')
    assertEquals(writes[0].commit_sha, 'commit')
  } finally { globalThis.fetch = original }
})
Deno.test('missing private connection fails closed before any GitHub request', async () => {
  const original = globalThis.fetch
  let fetched = false
  let status = ''
  const client = { rpc: () => ({ error: null, data: null }), from: () => ({ select: () => ({ eq: () => ({ maybeSingle: () => ({ data: null }) }) }), update: (v: { status: string }) => {
    status = v.status
    const query = { eq: () => query, then: (resolve: (v: unknown) => void) => resolve({}) }; return query
  } }) }
  globalThis.fetch = () => { fetched = true; throw new Error('must not fetch') }
  try {
    await syncRepository(client, { id: 'r', owner_id: 'owner', vault_secret_id: 'private' }, 'run')
    assertEquals(fetched, false)
    assertEquals(status, 'error')
  } finally { globalThis.fetch = original }
})

Deno.test('existing Secrets scope and allowed hosts are enforced before decryption', async () => {
  let secret = { name: 'github', scope: 'private', owner_id: 'other', allowed_hosts: ['api.github.com'] }
  const client = { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: () => ({ data: secret }) }) }) }) }
  await assertRejects(() => githubSecret(client, 'id', 'owner'), Error, 'not shared')
  secret = { ...secret, owner_id: 'owner', allowed_hosts: ['api.other.com'] }
  await assertRejects(() => githubSecret(client, 'id', 'owner'), Error, 'Allowed hosts')
  secret = { ...secret, scope: 'workspace', allowed_hosts: ['api.github.com'] }
  assertEquals((await githubSecret(client, 'id', 'member')).name, 'github')
})
