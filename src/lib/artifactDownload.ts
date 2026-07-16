import type { Database } from './database.types'

type Artifact = Database['public']['Tables']['artifacts']['Row']

/**
 * Generates markdown content from multiple artifacts with metadata and separators
 */
export function generateMarkdownContent(artifacts: Artifact[], formatDate: (date: string) => string): string {
  let markdownContent = ''

  artifacts.forEach((artifact, index) => {
    if (index > 0) {
      markdownContent += '\n\n---\n\n' // Separator between artifacts
    }

    // Add artifact title as heading
    markdownContent += `# ${artifact.title}\n\n`

    // Add metadata
    markdownContent += `**Type:** ${artifact.type}  \n`
    markdownContent += `**Updated:** ${formatDate(artifact.updated_at)}  \n`
    markdownContent += `**Visibility:** ${artifact.visibility}\n\n`

    // Add content
    markdownContent += artifact.content || '(empty)'
  })

  return markdownContent
}

/**
 * Generates a filename for the downloaded markdown file
 */
export function generateFilename(artifacts: Artifact[]): string {
  if (artifacts.length === 1) {
    // Single artifact: use its title as filename
    return `${artifacts[0].title.replace(/[^a-z0-9]/gi, '_').toLowerCase()}.md`
  } else {
    // Multiple artifacts: use a descriptive name with count and date
    return `artifacts_${artifacts.length}_items_${new Date().toISOString().split('T')[0]}.md`
  }
}

/**
 * Downloads markdown content as a file
 */
export function downloadMarkdown(content: string, filename: string): void {
  const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
}
