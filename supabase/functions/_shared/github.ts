// Shared GitHub helpers for the `github-webhook` ingest function: HMAC signature
// verification, glob matching for the include list, and the small slice of the
// GitHub REST API we need (fetch a file's raw text, walk a branch's tree). All
// read-only and dependency-free (Web Crypto + fetch).

const GH_API = 'https://api.github.com'
const RAW_ACCEPT = 'application/vnd.github.raw'
const JSON_ACCEPT = 'application/vnd.github+json'
const UA = 'supabase-intranet-kb'
const MAX_FILE_BYTES = 1_000_000 // skip anything bigger than ~1MB of text

// Verify GitHub's X-Hub-Signature-256 (HMAC-SHA256 of the raw body) in constant
// time. Returns false on any malformed input.
export async function verifySignature(secret: string, rawBody: string, header: string | null): Promise<boolean> {
  if (!header || !header.startsWith('sha256=')) return false
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const mac = await crypto.subtle.sign('HMAC', key, enc.encode(rawBody))
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('')
  return timingSafeEqual(`sha256=${hex}`, header)
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let out = 0
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return out === 0
}

// Translate a gitignore-ish glob to an anchored RegExp. Supports `*` (any run of
// non-slash chars), `**` (any chars incl. slashes), and `**/` (zero or more path
// segments). Everything else is matched literally.
export function globToRegex(glob: string): RegExp {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') {
          re += '(?:.*/)?'
          i += 2
        } else {
          re += '.*'
          i += 1
        }
      } else {
        re += '[^/]*'
      }
    } else if ('\\^$.|?+()[]{}'.includes(c)) {
      re += '\\' + c
    } else {
      re += c
    }
  }
  return new RegExp('^' + re + '$')
}

// Does a repo-relative path match any of the include globs?
export function matchesAny(path: string, globs: string[]): boolean {
  const p = path.replace(/^\/+/, '')
  return globs.some((g) => globToRegex(g.trim()).test(p))
}

function ghHeaders(pat: string | null, accept: string): HeadersInit {
  const h: Record<string, string> = { Accept: accept, 'User-Agent': UA, 'X-GitHub-Api-Version': '2022-11-28' }
  if (pat) h.Authorization = `Bearer ${pat}`
  return h
}

// Fetch one file's raw text from a repo at a ref. Returns null if missing, too
// large, or apparently binary. `repo` is 'owner/name'.
export async function fetchFile(repo: string, path: string, ref: string, pat: string | null): Promise<string | null> {
  const url = `${GH_API}/repos/${repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(ref)}`
  const res = await fetch(url, { headers: ghHeaders(pat, RAW_ACCEPT) })
  if (!res.ok) return null
  const len = Number(res.headers.get('content-length') ?? '0')
  if (len > MAX_FILE_BYTES) {
    await res.body?.cancel()
    return null
  }
  const text = await res.text()
  if (text.length > MAX_FILE_BYTES) return null
  // Heuristic: skip files containing a NUL byte (binary).
  if (text.indexOf('\u0000') !== -1) return null
  return text
}

export interface TreeEntry {
  path: string
  type: string // 'blob' | 'tree'
  size?: number
}

// List every blob path on a branch (recursive). `truncated` flags very large
// repos where GitHub capped the response.
export async function fetchTree(repo: string, branch: string, pat: string | null): Promise<{ paths: string[]; truncated: boolean }> {
  const url = `${GH_API}/repos/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`
  const res = await fetch(url, { headers: ghHeaders(pat, JSON_ACCEPT) })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`GitHub tree fetch failed (${res.status}): ${body.slice(0, 200)}`)
  }
  const data = await res.json() as { tree?: TreeEntry[]; truncated?: boolean }
  const paths = (data.tree ?? []).filter((e) => e.type === 'blob').map((e) => e.path)
  return { paths, truncated: Boolean(data.truncated) }
}

// Stable external ref for a synced file / issue / PR, used to update-in-place.
export function fileRef(repo: string, path: string, branch: string): string {
  return `${repo}:${path}@${branch}`
}
export function topicRef(repo: string, kind: 'issues' | 'pull', number: number): string {
  return `${repo}#${kind}/${number}`
}
