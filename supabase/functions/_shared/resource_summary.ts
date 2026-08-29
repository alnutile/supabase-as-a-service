// Pure normalization/classification helpers for the reusable resource summarizer.
export type SummarySourceKind = 'link' | 'file' | 'artifact' | 'inbox_message' | 'knowledge_page' | 'text'
export type SummaryStyle = 'tldr' | 'brief' | 'detailed'

const SOURCE_KINDS: SummarySourceKind[] = ['link', 'file', 'artifact', 'inbox_message', 'knowledge_page', 'text']

export function normalizeSummarySourceKind(value: unknown): SummarySourceKind | null {
  const kind = String(value ?? '') as SummarySourceKind
  return SOURCE_KINDS.includes(kind) ? kind : null
}

const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'csv', 'json', 'xml', 'html', 'htm', 'js', 'jsx', 'ts', 'tsx', 'py', 'rb', 'php',
  'java', 'go', 'rs', 'sql', 'css', 'scss', 'yaml', 'yml', 'toml', 'log',
])
const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

export function normalizeSummaryStyle(value: unknown): SummaryStyle {
  return value === 'brief' || value === 'detailed' ? value : 'tldr'
}

export function clampSummaryWords(value: unknown, style: SummaryStyle): number {
  const fallback = style === 'detailed' ? 250 : style === 'brief' ? 140 : 80
  const n = Number(value)
  return Number.isFinite(n) ? Math.max(20, Math.min(500, Math.round(n))) : fallback
}

export function summaryFileKind(name: string, mime = ''): 'text' | 'pdf' | 'image' | null {
  const cleanMime = mime.split(';')[0].trim().toLowerCase()
  const ext = name.toLowerCase().split('.').pop() ?? ''
  if (cleanMime === 'application/pdf' || ext === 'pdf') return 'pdf'
  if (IMAGE_MIMES.has(cleanMime) || ['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(ext)) return 'image'
  if (cleanMime.startsWith('text/') || TEXT_EXTENSIONS.has(ext) || ['application/json', 'application/xml'].includes(cleanMime)) {
    return 'text'
  }
  return null
}

export function cleanSummary(value: string): string {
  return value
    .replace(/^```(?:text)?\s*/i, '')
    .replace(/```$/i, '')
    .replace(/^(?:tl;?dr|summary)\s*:\s*/i, '')
    .trim()
}
