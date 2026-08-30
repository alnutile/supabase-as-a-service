import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import {
  clampSummaryWords,
  cleanSummary,
  normalizeSummarySourceKind,
  normalizeSummaryStyle,
  summaryFileKind,
} from '../_shared/resource_summary.ts'

Deno.test('summary source kinds fail closed', () => {
  assertEquals(normalizeSummarySourceKind('link'), 'link')
  assertEquals(normalizeSummarySourceKind('something_else'), null)
  assertEquals(normalizeSummarySourceKind(null), null)
})

Deno.test('summary style and word limits normalize safely', () => {
  assertEquals(normalizeSummaryStyle('brief'), 'brief')
  assertEquals(normalizeSummaryStyle('unknown'), 'tldr')
  assertEquals(clampSummaryWords(undefined, 'tldr'), 80)
  assertEquals(clampSummaryWords(2, 'brief'), 20)
  assertEquals(clampSummaryWords(9999, 'detailed'), 500)
})

Deno.test('summaryFileKind recognizes supported text, PDF, and image formats', () => {
  assertEquals(summaryFileKind('notes.md', ''), 'text')
  assertEquals(summaryFileKind('data', 'application/json'), 'text')
  assertEquals(summaryFileKind('report.bin', 'application/pdf'), 'pdf')
  assertEquals(summaryFileKind('photo.jpg', 'application/octet-stream'), 'image')
  assertEquals(summaryFileKind('archive.zip', 'application/zip'), null)
})

Deno.test('cleanSummary removes wrappers without changing the summary', () => {
  assertEquals(cleanSummary('TLDR: A concise result.'), 'A concise result.')
  assertEquals(cleanSummary('```text\nA concise result.\n```'), 'A concise result.')
})
