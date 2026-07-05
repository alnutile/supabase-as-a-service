import { describe, expect, it } from 'vitest'
import { parseArtifactBlocks } from './artifacts'

const block = (header: string, content: string) => `:::artifact ${header}\n${content}\n:::`

describe('parseArtifactBlocks', () => {
  it('passes plain text through untouched', () => {
    expect(parseArtifactBlocks('hello **world**')).toEqual([
      { kind: 'text', text: 'hello **world**' },
    ])
  })

  it('parses a single block with surrounding prose', () => {
    const text = `Here it is:\n${block('{"title":"My Doc","type":"markdown"}', '# Hi')}\nEnjoy!`
    expect(parseArtifactBlocks(text)).toEqual([
      { kind: 'text', text: 'Here it is:\n' },
      { kind: 'artifact', title: 'My Doc', type: 'markdown', content: '# Hi' },
      { kind: 'text', text: '\nEnjoy!' },
    ])
  })

  it('parses multiple blocks in one message', () => {
    const text =
      block('{"title":"A","type":"html"}', '<p>a</p>') +
      '\nand\n' +
      block('{"title":"B","type":"code"}', 'x = 1')
    const chunks = parseArtifactBlocks(text)
    expect(chunks.filter((c) => c.kind === 'artifact')).toHaveLength(2)
    expect(chunks[0]).toMatchObject({ type: 'html', content: '<p>a</p>' })
    expect(chunks[2]).toMatchObject({ type: 'code', content: 'x = 1' })
  })

  it('keeps a malformed-JSON header block as visible text', () => {
    const bad = block('{title: broken}', 'content')
    expect(parseArtifactBlocks(bad)).toEqual([{ kind: 'text', text: bad }])
  })

  it('falls back to markdown for unknown types and untitled blocks', () => {
    const [chunk] = parseArtifactBlocks(block('{"type":"powerpoint"}', 'stuff'))
    expect(chunk).toEqual({
      kind: 'artifact',
      title: 'Untitled artifact',
      type: 'markdown',
      content: 'stuff',
    })
  })

  it('caps runaway titles at 120 chars', () => {
    const [chunk] = parseArtifactBlocks(block(`{"title":"${'x'.repeat(300)}"}`, 'c'))
    expect(chunk.kind).toBe('artifact')
    if (chunk.kind === 'artifact') expect(chunk.title).toHaveLength(120)
  })

  it('trims the content but preserves interior newlines', () => {
    const [chunk] = parseArtifactBlocks(block('{"title":"T"}', '  line1\n\nline2  '))
    if (chunk.kind === 'artifact') expect(chunk.content).toBe('line1\n\nline2')
  })

  it('handles CRLF line endings', () => {
    const text = `:::artifact {"title":"T","type":"text"}\r\nwindows\r\n:::`
    expect(parseArtifactBlocks(text)[0]).toMatchObject({ kind: 'artifact', content: 'windows' })
  })

  it('is stateless across calls (fresh regex lastIndex)', () => {
    const text = block('{"title":"T"}', 'c')
    expect(parseArtifactBlocks(text)).toEqual(parseArtifactBlocks(text))
  })
})
