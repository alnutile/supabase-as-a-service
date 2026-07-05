// Parsing for the assistant's `:::artifact {json}\n…\n:::` protocol (taught by
// the seeded "How this workspace works" prompt). Extracted from ChatPage so the
// format's edge cases are unit-testable — ChatPage's materializeArtifacts owns
// the side effects (DB insert, link replacement); this owns the parsing.

export const ARTIFACT_TYPES = ['markdown', 'code', 'html', 'text'] as const
export type ArtifactBlockType = (typeof ARTIFACT_TYPES)[number]

export type ParsedChunk =
  // Prose to pass through untouched — including malformed blocks, which are
  // deliberately left as-is rather than half-parsed.
  | { kind: 'text'; text: string }
  | { kind: 'artifact'; title: string; type: ArtifactBlockType; content: string }

const BLOCK_RE = /:::artifact\s*(\{[\s\S]*?\})\s*\r?\n([\s\S]*?)\r?\n:::/g

export function parseArtifactBlocks(text: string): ParsedChunk[] {
  const chunks: ParsedChunk[] = []
  let last = 0
  let m: RegExpExecArray | null
  const re = new RegExp(BLOCK_RE) // fresh lastIndex per call
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) chunks.push({ kind: 'text', text: text.slice(last, m.index) })
    last = re.lastIndex
    let attrs: { title?: string; type?: string } = {}
    try {
      attrs = JSON.parse(m[1])
    } catch {
      // malformed header — keep the whole block as visible text
      chunks.push({ kind: 'text', text: m[0] })
      continue
    }
    const type = (ARTIFACT_TYPES as readonly string[]).includes(attrs.type ?? '')
      ? (attrs.type as ArtifactBlockType)
      : 'markdown'
    chunks.push({
      kind: 'artifact',
      title: (attrs.title || 'Untitled artifact').slice(0, 120),
      type,
      content: m[2].trim(),
    })
  }
  if (last < text.length) chunks.push({ kind: 'text', text: text.slice(last) })
  return chunks
}
