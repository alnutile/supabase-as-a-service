import { describe, expect, it } from 'vitest'
import { normalizeGitHubUrl } from './githubUrl'

describe('normalizeGitHubUrl', () => {
  it('passes through raw.githubusercontent.com URLs unchanged', () => {
    const url = 'https://raw.githubusercontent.com/user/repo/main/file.md'
    expect(normalizeGitHubUrl(url)).toBe(url)
  })

  it('converts blob URLs to raw URLs', () => {
    const input = 'https://github.com/user/repo/blob/main/path/to/file.md'
    const expected = 'https://raw.githubusercontent.com/user/repo/main/path/to/file.md'
    expect(normalizeGitHubUrl(input)).toBe(expected)
  })

  it('converts blob URLs with different branches', () => {
    const input = 'https://github.com/user/repo/blob/develop/file.md'
    const expected = 'https://raw.githubusercontent.com/user/repo/develop/file.md'
    expect(normalizeGitHubUrl(input)).toBe(expected)
  })

  it('converts repo root URLs to README.md on main branch', () => {
    const input = 'https://github.com/user/repo'
    const expected = 'https://raw.githubusercontent.com/user/repo/main/README.md'
    expect(normalizeGitHubUrl(input)).toBe(expected)
  })

  it('converts repo root URLs with trailing slash', () => {
    const input = 'https://github.com/user/repo/'
    const expected = 'https://raw.githubusercontent.com/user/repo/main/README.md'
    expect(normalizeGitHubUrl(input)).toBe(expected)
  })

  it('converts gist URLs to raw gist URLs', () => {
    const input = 'https://gist.github.com/user/abc123def456'
    const expected = 'https://gist.githubusercontent.com/user/abc123def456/raw'
    expect(normalizeGitHubUrl(input)).toBe(expected)
  })

  it('handles nested path blob URLs', () => {
    const input = 'https://github.com/user/repo/blob/main/docs/guides/skill.md'
    const expected = 'https://raw.githubusercontent.com/user/repo/main/docs/guides/skill.md'
    expect(normalizeGitHubUrl(input)).toBe(expected)
  })

  it('returns invalid URLs unchanged', () => {
    const input = 'not a url'
    expect(normalizeGitHubUrl(input)).toBe(input)
  })

  it('returns non-GitHub URLs unchanged', () => {
    const input = 'https://example.com/file.md'
    expect(normalizeGitHubUrl(input)).toBe(input)
  })
})
