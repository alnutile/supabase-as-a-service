import { describe, expect, it } from 'vitest'
import {
  parseSkillMarkdown,
  serializeSkillMarkdown,
  skillFilename,
} from './skillFormat'

describe('serializeSkillMarkdown', () => {
  it('starts with a YAML frontmatter block of name + description', () => {
    const md = serializeSkillMarkdown({
      name: 'Weekly report',
      description: 'Summarize the week',
      instructions: 'Do the thing.',
    })
    expect(md).toBe(
      ['---', 'name: Weekly report', 'description: Summarize the week', '---', '', 'Do the thing.', ''].join('\n'),
    )
  })

  it('quotes values that would break the YAML scalar', () => {
    const md = serializeSkillMarkdown({
      name: 'Ratio: a:b',
      description: '',
      instructions: 'x',
    })
    expect(md).toContain('name: "Ratio: a:b"')
    expect(md).toContain('description: ""')
  })

  it('collapses newlines in scalar values', () => {
    const md = serializeSkillMarkdown({
      name: 'A',
      description: 'line one\nline two',
      instructions: 'body',
    })
    expect(md).toContain('description: line one line two')
  })
})

describe('parseSkillMarkdown', () => {
  it('parses name, description, and instructions', () => {
    const doc = parseSkillMarkdown(
      ['---', 'name: Weekly report', 'description: Summarize the week', '---', '', 'Do the thing.'].join('\n'),
    )
    expect(doc).toEqual({
      name: 'Weekly report',
      description: 'Summarize the week',
      instructions: 'Do the thing.',
    })
  })

  it('is a round-trip with serialize', () => {
    const original = {
      name: 'My skill',
      description: 'Does: something tricky',
      instructions: 'Line 1\n\nLine 2',
    }
    const parsed = parseSkillMarkdown(serializeSkillMarkdown(original))
    expect(parsed).toEqual(original)
  })

  it('unwraps a surrounding markdown code fence', () => {
    const doc = parseSkillMarkdown(
      ['```markdown', '---', 'name: Fenced', 'description: d', '---', '', 'body', '```'].join('\n'),
    )
    expect(doc.name).toBe('Fenced')
    expect(doc.instructions).toBe('body')
  })

  it('treats text without frontmatter as instructions only', () => {
    const doc = parseSkillMarkdown('Just some instructions.')
    expect(doc.name).toBeUndefined()
    expect(doc.description).toBeUndefined()
    expect(doc.instructions).toBe('Just some instructions.')
  })

  it('handles frontmatter with an empty body', () => {
    const doc = parseSkillMarkdown(['---', 'name: Empty', 'description: none', '---'].join('\n'))
    expect(doc.name).toBe('Empty')
    expect(doc.instructions).toBe('')
  })

  it('unquotes double-quoted scalars', () => {
    const doc = parseSkillMarkdown(['---', 'name: "Ratio: a:b"', 'description: "d"', '---', '', 'x'].join('\n'))
    expect(doc.name).toBe('Ratio: a:b')
    expect(doc.description).toBe('d')
  })
})

describe('skillFilename', () => {
  it('slugifies the skill name', () => {
    expect(skillFilename('Weekly Report!')).toBe('weekly-report.md')
  })

  it('falls back to skill.md for empty names', () => {
    expect(skillFilename('   ')).toBe('skill.md')
    expect(skillFilename('!!!')).toBe('skill.md')
  })
})
