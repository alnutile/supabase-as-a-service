import { describe, expect, it, vi } from 'vitest'

// Mock the environment variables
vi.stubEnv('VITE_SUPABASE_URL', 'https://test-project.supabase.co')
vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'test-anon-key')

// Import after mocking env vars
const { artifactImageUrl } = await import('./supabase')

describe('artifactImageUrl', () => {
  it('generates correct proxy URL for artifact images', () => {
    const path = 'user123/abc-def-123/photo.png'
    const url = artifactImageUrl(path)
    expect(url).toBe('https://test-project.supabase.co/functions/v1/artifact-image/user123/abc-def-123/photo.png')
  })

  it('handles paths with slashes', () => {
    const path = 'user456/uuid-here/subfolder/image.jpg'
    const url = artifactImageUrl(path)
    expect(url).toBe('https://test-project.supabase.co/functions/v1/artifact-image/user456/uuid-here/subfolder/image.jpg')
  })

  it('preserves special characters in filename', () => {
    const path = 'user789/xyz-123/my photo (1).png'
    const url = artifactImageUrl(path)
    expect(url).toBe('https://test-project.supabase.co/functions/v1/artifact-image/user789/xyz-123/my photo (1).png')
  })
})
