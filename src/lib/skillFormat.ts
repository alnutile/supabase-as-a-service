/**
 * The portable "skill file" format: a Markdown document that opens with a YAML
 * frontmatter block (`name`, `description`) delimited by `---`, followed by the
 * skill's instructions as the body. This mirrors the SKILL.md convention used by
 * Claude/agent skills, so a skill can be downloaded, shared, and re-imported.
 *
 * Pure logic on purpose (kept out of SkillsPage) so it can be unit-tested — see
 * skillFormat.test.ts.
 */

export interface SkillDoc {
  name?: string
  description?: string
  instructions: string
}

/** Serialize a skill into the frontmatter Markdown format. */
export function serializeSkillMarkdown(doc: SkillDoc): string {
  const lines = [
    '---',
    `name: ${yamlScalar(doc.name ?? '')}`,
    `description: ${yamlScalar(doc.description ?? '')}`,
    '---',
    '',
    doc.instructions.trim(),
    '',
  ]
  return lines.join('\n')
}

/**
 * Parse a skill file back into its parts. Tolerant of a wrapping ```` ```md ````
 * code fence (the model tends to add one) and of missing frontmatter (the whole
 * text is then treated as the instructions).
 */
export function parseSkillMarkdown(raw: string): SkillDoc {
  let text = raw.replace(/^﻿/, '').trim()

  // Unwrap a single surrounding code fence, e.g. ```markdown … ```
  const fence = text.match(/^```[a-zA-Z]*\r?\n([\s\S]*?)\r?\n```$/)
  if (fence) text = fence[1].trim()

  const fm = text.match(
    /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n([\s\S]*))?$/,
  )
  if (!fm) return { instructions: text }

  const meta: Record<string, string> = {}
  for (const line of fm[1].split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/)
    if (m) meta[m[1].toLowerCase()] = unquoteScalar(m[2].trim())
  }

  return {
    name: meta.name || undefined,
    description: meta.description || undefined,
    instructions: (fm[2] ?? '').trim(),
  }
}

/** A safe `.md` filename for a downloaded skill, derived from its name. */
export function skillFilename(name: string): string {
  const slug =
    name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'skill'
  return `${slug}.md`
}

/** Render a string as a YAML scalar, quoting only when needed. */
function yamlScalar(value: string): string {
  const s = value.trim().replace(/\s*\r?\n\s*/g, ' ')
  if (s === '') return '""'
  const needsQuote =
    /[:#"'\\]/.test(s) || /^[-?&*!|>@`%[\]{},]/.test(s) || /^\s|\s$/.test(value)
  if (needsQuote) {
    return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
  }
  return s
}

/** Inverse of {@link yamlScalar} for the values we emit. */
function unquoteScalar(value: string): string {
  if (value.length >= 2 && value[0] === '"' && value.endsWith('"')) {
    return value
      .slice(1, -1)
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\')
  }
  if (value.length >= 2 && value[0] === "'" && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'")
  }
  return value
}
