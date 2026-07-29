/**
 * Convert various GitHub URL formats to raw content URLs.
 * Supports:
 * - github.com/user/repo/blob/branch/path/file.md → raw.githubusercontent.com
 * - raw.githubusercontent.com URLs (pass through)
 * - github.com/user/repo (fetches README.md)
 * - gist.github.com URLs → raw gist URLs
 */
export function normalizeGitHubUrl(url: string): string {
  try {
    const u = new URL(url)

    // Already a raw URL
    if (u.hostname === 'raw.githubusercontent.com') return url

    // Gist URL: github.com/user/gist-id or gist.github.com/user/gist-id
    const gistMatch = url.match(/gist\.github\.com\/([^/]+)\/([a-f0-9]+)/)
    if (gistMatch) {
      return `https://gist.githubusercontent.com/${gistMatch[1]}/${gistMatch[2]}/raw`
    }

    // Regular GitHub file: github.com/user/repo/blob/branch/path/to/file.md
    const blobMatch = u.pathname.match(/^\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)$/)
    if (blobMatch) {
      const [, owner, repo, branch, path] = blobMatch
      return `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${path}`
    }

    // GitHub repo root: github.com/user/repo → README.md
    const repoMatch = u.pathname.match(/^\/([^/]+)\/([^/]+)\/?$/)
    if (repoMatch && u.hostname === 'github.com') {
      const [, owner, repo] = repoMatch
      // Try to fetch README.md from main/master branch
      return `https://raw.githubusercontent.com/${owner}/${repo}/main/README.md`
    }

    return url
  } catch {
    return url
  }
}
