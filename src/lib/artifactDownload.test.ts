import { describe, it, expect } from 'vitest'
import { generateMarkdownContent, generateFilename } from './artifactDownload'
import type { Database } from './database.types'

type Artifact = Database['public']['Tables']['artifacts']['Row']

const mockFormatDate = (date: string) => new Date(date).toLocaleDateString()

const mockArtifact = (overrides: Partial<Artifact> = {}): Artifact => ({
  id: '123e4567-e89b-12d3-a456-426614174000',
  owner_id: 'user-123',
  conversation_id: null,
  title: 'Test Artifact',
  type: 'markdown',
  language: null,
  content: '# Test Content\n\nThis is a test.',
  visibility: 'private',
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-02T00:00:00Z',
  public_slug: null,
  share_password_hash: null,
  data: null,
  ...overrides,
})

describe('generateMarkdownContent', () => {
  it('generates markdown for a single artifact', () => {
    const artifact = mockArtifact({
      title: 'My Document',
      type: 'markdown',
      content: '# Hello World',
      visibility: 'public',
      updated_at: '2024-01-15T10:30:00Z',
    })

    const result = generateMarkdownContent([artifact], mockFormatDate)

    expect(result).toContain('# My Document')
    expect(result).toContain('**Type:** markdown')
    expect(result).toContain('**Visibility:** public')
    expect(result).toContain('# Hello World')
  })

  it('generates markdown for multiple artifacts with separators', () => {
    const artifacts = [
      mockArtifact({ title: 'First', content: 'Content 1' }),
      mockArtifact({ title: 'Second', content: 'Content 2' }),
    ]

    const result = generateMarkdownContent(artifacts, mockFormatDate)

    expect(result).toContain('# First')
    expect(result).toContain('Content 1')
    expect(result).toContain('\n\n---\n\n')
    expect(result).toContain('# Second')
    expect(result).toContain('Content 2')
  })

  it('handles empty content gracefully', () => {
    const artifact = mockArtifact({ content: '' })

    const result = generateMarkdownContent([artifact], mockFormatDate)

    expect(result).toContain('(empty)')
  })

  it('includes metadata for each artifact', () => {
    const artifact = mockArtifact({
      type: 'code',
      visibility: 'unlisted',
      updated_at: '2024-03-20T15:45:00Z',
    })

    const result = generateMarkdownContent([artifact], mockFormatDate)

    expect(result).toContain('**Type:** code')
    expect(result).toContain('**Updated:**')
    expect(result).toContain('**Visibility:** unlisted')
  })
})

describe('generateFilename', () => {
  it('generates filename from single artifact title', () => {
    const artifact = mockArtifact({ title: 'My Cool Document!' })

    const result = generateFilename([artifact])

    expect(result).toBe('my_cool_document_.md')
  })

  it('sanitizes special characters in single artifact filename', () => {
    const artifact = mockArtifact({ title: 'Test @ #1: (Version 2)' })

    const result = generateFilename([artifact])

    expect(result).toBe('test____1___version_2_.md')
    expect(result).toMatch(/\.md$/)
  })

  it('generates descriptive filename for multiple artifacts', () => {
    const artifacts = [
      mockArtifact({ title: 'First' }),
      mockArtifact({ title: 'Second' }),
      mockArtifact({ title: 'Third' }),
    ]

    const result = generateFilename(artifacts)

    expect(result).toMatch(/^artifacts_3_items_\d{4}-\d{2}-\d{2}\.md$/)
    expect(result).toContain('artifacts_3_items_')
  })

  it('generates filename with current date for multiple artifacts', () => {
    const artifacts = [mockArtifact(), mockArtifact()]
    const today = new Date().toISOString().split('T')[0]

    const result = generateFilename(artifacts)

    expect(result).toBe(`artifacts_2_items_${today}.md`)
  })
})
