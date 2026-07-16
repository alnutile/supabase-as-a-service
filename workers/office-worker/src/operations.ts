// OfficeCLI operations. Word/Excel/PowerPoint work via LibreOffice headless
// (`soffice`) for conversion/rendering, poppler (`pdftoppm`) for PDF→PNG
// previews, and the `docx` library to author new documents. Every operation is
// narrow and allow-listed — there is deliberately no freeform "run soffice with
// these args".
import { promises as fs } from 'node:fs'
import path from 'node:path'
import {
  PermanentError,
  runCommand,
  uploadOutput,
  uploadReportArtifact,
  type JobContext,
  type OutputRef,
} from '@supanet/worker-shared'
import { Document, Packer, Paragraph, HeadingLevel, TextRun } from 'docx'

const OFFICE_EXTS = new Set(['docx', 'doc', 'xlsx', 'xls', 'pptx', 'ppt', 'odt', 'ods', 'odp'])
const SOFFICE_TIMEOUT = 180_000

function extOf(name: string): string {
  return path.extname(name).replace('.', '').toLowerCase()
}

function requireInput(ctx: JobContext, roles: string[] = []): { localPath: string; filename: string } {
  const wanted = ctx.inputs.find((i) => roles.length === 0 || roles.includes(i.ref.role ?? '')) ?? ctx.inputs[0]
  if (!wanted) throw new PermanentError('This operation requires an input document.')
  return { localPath: wanted.localPath, filename: wanted.filename }
}

// Run `soffice --headless --convert-to <target>` into outDir, returning the
// produced file path.
async function sofficeConvert(srcPath: string, target: string, outDir: string): Promise<string> {
  const res = await runCommand(
    'soffice',
    ['--headless', '--norestore', '--convert-to', target, '--outdir', outDir, srcPath],
    { timeoutMs: SOFFICE_TIMEOUT },
  )
  // soffice's exit code is unreliable; verify the output file exists instead.
  const base = path.basename(srcPath, path.extname(srcPath))
  const targetExt = target.split(':')[0]
  const produced = path.join(outDir, `${base}.${targetExt}`)
  try {
    await fs.access(produced)
  } catch {
    throw new Error(`soffice did not produce ${targetExt} (${res.stderr.slice(0, 200)})`)
  }
  return produced
}

// PDF → one PNG per page (capped) via poppler's pdftoppm.
async function pdfToPngs(pdfPath: string, outDir: string, maxPages: number): Promise<string[]> {
  const prefix = path.join(outDir, 'page')
  await runCommand('pdftoppm', ['-png', '-r', '110', '-l', String(maxPages), pdfPath, prefix], {
    timeoutMs: 120_000,
  })
  const files = (await fs.readdir(outDir))
    .filter((f) => f.startsWith('page') && f.endsWith('.png'))
    .sort()
    .slice(0, maxPages)
  return files.map((f) => path.join(outDir, f))
}

export async function inspectDocument(ctx: JobContext): Promise<OutputRef[]> {
  const input = requireInput(ctx)
  const ext = extOf(input.filename)
  if (!OFFICE_EXTS.has(ext)) throw new PermanentError(`inspect_document does not support .${ext} files.`)

  // Extract text by converting to plain text (docx/pptx) or CSV (xlsx).
  const isSheet = ext === 'xlsx' || ext === 'xls' || ext === 'ods'
  const txtTarget = isSheet ? 'csv' : 'txt:Text'
  const produced = await sofficeConvert(input.localPath, txtTarget, ctx.tmpDir)
  const text = await fs.readFile(produced, 'utf8').catch(() => '')

  const stat = await fs.stat(input.localPath)
  const summary = {
    filename: input.filename,
    type: ext,
    size_bytes: stat.size,
    characters: text.length,
    words: text.split(/\s+/).filter(Boolean).length,
    lines: text.split(/\r?\n/).length,
  }
  const preview = text.slice(0, 4000)
  const md = [
    `# Document inspection: ${input.filename}`,
    '',
    `- **Type:** ${ext}`,
    `- **Size:** ${stat.size} bytes`,
    `- **Words:** ${summary.words}`,
    `- **Lines:** ${summary.lines}`,
    '',
    '## Extracted text (preview)',
    '',
    '```',
    preview,
    '```',
  ].join('\n')
  ctx.log('inspected document', { type: ext, words: summary.words })

  const report = await uploadReportArtifact(ctx.db, ctx.ownerId, {
    title: `Inspection: ${input.filename}`,
    content: md,
    role: 'inspection_report',
  })
  // Also return the structured JSON as a file so the AI can parse it.
  const jsonPath = path.join(ctx.tmpDir, 'inspection.json')
  await fs.writeFile(jsonPath, JSON.stringify({ ...summary, text_preview: preview }, null, 2))
  const json = await uploadOutput(ctx.db, ctx.ownerId, jsonPath, {
    filename: `${path.basename(input.filename, path.extname(input.filename))}-inspection.json`,
    mimeType: 'application/json',
    role: 'structured_data',
  })
  return [report, json]
}

export async function renderDocument(ctx: JobContext): Promise<OutputRef[]> {
  const input = requireInput(ctx)
  const ext = extOf(input.filename)
  if (!OFFICE_EXTS.has(ext)) throw new PermanentError(`render_document does not support .${ext} files.`)
  const maxPages = clampNum(ctx.parameters.max_pages, 5, 1, 20)

  const pdf = await sofficeConvert(input.localPath, 'pdf', ctx.tmpDir)
  const pngs = await pdfToPngs(pdf, ctx.tmpDir, maxPages)
  ctx.log('rendered document', { pages: pngs.length })

  const outputs: OutputRef[] = []
  const pdfOut = await uploadOutput(ctx.db, ctx.ownerId, pdf, {
    filename: `${baseName(input.filename)}.pdf`,
    mimeType: 'application/pdf',
    role: 'rendered_pdf',
  })
  outputs.push(pdfOut)
  let i = 1
  for (const png of pngs) {
    outputs.push(
      await uploadOutput(ctx.db, ctx.ownerId, png, {
        filename: `${baseName(input.filename)}-p${i}.png`,
        mimeType: 'image/png',
        role: 'rendered_preview',
      }),
    )
    i++
  }
  return outputs
}

export async function convertDocument(ctx: JobContext): Promise<OutputRef[]> {
  const input = requireInput(ctx)
  const target = String(ctx.parameters.target_format ?? ctx.parameters.format ?? 'pdf').toLowerCase()
  const allowed = new Set(['pdf', 'docx', 'odt', 'xlsx', 'ods', 'pptx', 'csv', 'txt', 'html'])
  if (!allowed.has(target)) throw new PermanentError(`Unsupported target format "${target}".`)
  const produced = await sofficeConvert(input.localPath, target === 'txt' ? 'txt:Text' : target, ctx.tmpDir)
  ctx.log('converted document', { target })
  const mime = mimeForExt(target)
  const out = await uploadOutput(ctx.db, ctx.ownerId, produced, {
    filename: `${baseName(input.filename)}.${target}`,
    mimeType: mime,
    role: 'converted_document',
  })
  return [out]
}

// Author a new DOCX. The worker has no LLM: the main AI supplies the document
// body in `instructions` (markdown-ish — `# heading` lines become headings, blank
// lines split paragraphs). Reference inputs are noted in the validation report.
export async function createDocx(ctx: JobContext): Promise<OutputRef[]> {
  const body = ctx.instructions.trim()
  if (!body) throw new PermanentError('create_docx needs the document content in `instructions`.')
  const title = String(ctx.parameters.title ?? firstLine(body) ?? 'Document').slice(0, 120)

  const paragraphs: Paragraph[] = []
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, '')
    if (!line.trim()) {
      paragraphs.push(new Paragraph({ children: [] }))
      continue
    }
    const h = line.match(/^(#{1,3})\s+(.*)$/)
    if (h) {
      const level = h[1].length === 1 ? HeadingLevel.HEADING_1 : h[1].length === 2 ? HeadingLevel.HEADING_2 : HeadingLevel.HEADING_3
      paragraphs.push(new Paragraph({ heading: level, children: [new TextRun(h[2])] }))
    } else {
      paragraphs.push(new Paragraph({ children: [new TextRun(line)] }))
    }
  }

  const doc = new Document({ sections: [{ children: paragraphs }] })
  const buffer = await Packer.toBuffer(doc)
  const docxPath = path.join(ctx.tmpDir, 'document.docx')
  await fs.writeFile(docxPath, buffer)

  const filename = `${slug(title)}.docx`
  const docxOut = await uploadOutput(ctx.db, ctx.ownerId, docxPath, {
    filename,
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    role: 'editable_document',
  })

  // Rendered preview (best-effort — a preview failure must not fail the job).
  const outputs: OutputRef[] = [docxOut]
  try {
    const pdf = await sofficeConvert(docxPath, 'pdf', ctx.tmpDir)
    const pngs = await pdfToPngs(pdf, ctx.tmpDir, 1)
    if (pngs[0]) {
      outputs.push(
        await uploadOutput(ctx.db, ctx.ownerId, pngs[0], {
          filename: `${slug(title)}-preview.png`,
          mimeType: 'image/png',
          role: 'rendered_preview',
        }),
      )
    }
  } catch (err) {
    ctx.log('preview render skipped', { error: err instanceof Error ? err.message : String(err) })
  }

  const refNames = ctx.inputs.map((i) => `- ${i.ref.role ?? 'reference'}: ${i.filename}`).join('\n') || '- (none)'
  const report = await uploadReportArtifact(ctx.db, ctx.ownerId, {
    title: `Validation report: ${title}`,
    content: [
      `# Validation report`,
      '',
      `Created **${filename}** (${buffer.length} bytes).`,
      '',
      `## Inputs used`,
      refNames,
      '',
      `## Checks`,
      `- Document generated: ✅`,
      `- Paragraphs: ${paragraphs.length}`,
      `- Preview rendered: ${outputs.some((o) => o.role === 'rendered_preview') ? '✅' : '⚠️ skipped'}`,
    ].join('\n'),
    role: 'validation_report',
  })
  outputs.push(report)
  ctx.log('created docx', { paragraphs: paragraphs.length })
  return outputs
}

function clampNum(v: unknown, def: number, min: number, max: number): number {
  const n = Number(v)
  if (!Number.isFinite(n)) return def
  return Math.max(min, Math.min(max, Math.round(n)))
}
function baseName(name: string): string {
  return path.basename(name, path.extname(name))
}
function firstLine(s: string): string {
  return s.split(/\r?\n/).find((l) => l.trim())?.replace(/^#+\s*/, '') ?? ''
}
function slug(s: string): string {
  return s.toLowerCase().replace(/[^\w]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'document'
}
function mimeForExt(ext: string): string {
  const map: Record<string, string> = {
    pdf: 'application/pdf',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    odt: 'application/vnd.oasis.opendocument.text',
    ods: 'application/vnd.oasis.opendocument.spreadsheet',
    csv: 'text/csv',
    txt: 'text/plain',
    html: 'text/html',
  }
  return map[ext] ?? 'application/octet-stream'
}
