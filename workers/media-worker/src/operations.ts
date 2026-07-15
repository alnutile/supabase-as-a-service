// ffmpeg operations. Audio/video processing via ffmpeg/ffprobe. Every operation
// is narrow and allow-listed — timestamps/formats come through typed parameters,
// never a raw ffmpeg argument string from the user.
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

const FFMPEG_TIMEOUT = 300_000

function sourceInput(ctx: JobContext): { localPath: string; filename: string } {
  const wanted =
    ctx.inputs.find((i) => ['source_video', 'source', 'source_audio'].includes(i.ref.role ?? '')) ?? ctx.inputs[0]
  if (!wanted) throw new PermanentError('This operation requires a source media file.')
  return { localPath: wanted.localPath, filename: wanted.filename }
}

async function ffprobe(srcPath: string): Promise<Record<string, unknown>> {
  const res = await runCommand(
    'ffprobe',
    ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', srcPath],
    { timeoutMs: 60_000 },
  )
  if (res.code !== 0) throw new PermanentError(`ffprobe could not read the file (${res.stderr.slice(0, 200)}).`)
  try {
    return JSON.parse(res.stdout)
  } catch {
    throw new Error('ffprobe returned unparseable output.')
  }
}

function summarizeProbe(probe: Record<string, unknown>): Record<string, unknown> {
  const streams = Array.isArray(probe.streams) ? (probe.streams as Record<string, unknown>[]) : []
  const format = (probe.format ?? {}) as Record<string, unknown>
  const video = streams.find((s) => s.codec_type === 'video')
  const audio = streams.find((s) => s.codec_type === 'audio')
  return {
    duration_seconds: format.duration ? Number(format.duration) : null,
    size_bytes: format.size ? Number(format.size) : null,
    format_name: format.format_name ?? null,
    width: video?.width ?? null,
    height: video?.height ?? null,
    video_codec: video?.codec_name ?? null,
    audio_codec: audio?.codec_name ?? null,
    frame_rate: video?.r_frame_rate ?? null,
    streams: streams.length,
  }
}

export async function probe(ctx: JobContext): Promise<OutputRef[]> {
  const input = sourceInput(ctx)
  const info = summarizeProbe(await ffprobe(input.localPath))
  ctx.log('probed media', { duration: info.duration_seconds })
  const md = [
    `# Media metadata: ${input.filename}`,
    '',
    ...Object.entries(info).map(([k, v]) => `- **${k}:** ${v ?? '—'}`),
  ].join('\n')
  const report = await uploadReportArtifact(ctx.db, ctx.ownerId, {
    title: `Media probe: ${input.filename}`,
    content: md,
    role: 'media_metadata',
  })
  return [report]
}

export async function extractAudio(ctx: JobContext): Promise<OutputRef[]> {
  const input = sourceInput(ctx)
  const format = String(ctx.parameters.format ?? 'mp3').toLowerCase()
  const spec = audioSpec(format)
  if (!spec) throw new PermanentError(`Unsupported audio format "${format}" (use wav, mp3, or m4a).`)
  const outPath = path.join(ctx.tmpDir, `audio.${format}`)
  const args = ['-y', '-i', input.localPath, '-vn', ...spec.args, outPath]
  const res = await runCommand('ffmpeg', args, { timeoutMs: FFMPEG_TIMEOUT })
  await assertProduced(outPath, res.stderr)
  ctx.log('extracted audio', { format })
  const out = await uploadOutput(ctx.db, ctx.ownerId, outPath, {
    filename: `${baseName(input.filename)}.${format}`,
    mimeType: spec.mime,
    role: 'extracted_audio',
  })
  return [out]
}

export async function extractFrames(ctx: JobContext): Promise<OutputRef[]> {
  const input = sourceInput(ctx)
  const format = String(ctx.parameters.format ?? 'png').toLowerCase() === 'jpg' ? 'jpg' : 'png'
  const mime = format === 'jpg' ? 'image/jpeg' : 'image/png'
  const timestamps = parseTimestamps(ctx.parameters)
  const outputs: OutputRef[] = []

  if (timestamps.length) {
    let i = 1
    for (const ts of timestamps.slice(0, 20)) {
      const outPath = path.join(ctx.tmpDir, `frame-${String(i).padStart(3, '0')}.${format}`)
      const res = await runCommand(
        'ffmpeg',
        ['-y', '-ss', String(ts), '-i', input.localPath, '-frames:v', '1', outPath],
        { timeoutMs: 120_000 },
      )
      await assertProduced(outPath, res.stderr)
      outputs.push(
        await uploadOutput(ctx.db, ctx.ownerId, outPath, {
          filename: `frame-${String(i).padStart(3, '0')}.${format}`,
          mimeType: mime,
          role: 'preview_frame',
        }),
      )
      i++
    }
  } else {
    // Interval mode: one frame every N seconds (capped).
    const interval = clampNum(ctx.parameters.interval, 10, 1, 3600)
    const pattern = path.join(ctx.tmpDir, `frame-%03d.${format}`)
    const res = await runCommand(
      'ffmpeg',
      ['-y', '-i', input.localPath, '-vf', `fps=1/${interval}`, '-frames:v', '20', pattern],
      { timeoutMs: FFMPEG_TIMEOUT },
    )
    const files = (await fs.readdir(ctx.tmpDir)).filter((f) => f.startsWith('frame-') && f.endsWith(`.${format}`)).sort()
    if (!files.length) throw new Error(`ffmpeg produced no frames (${res.stderr.slice(0, 200)}).`)
    for (const f of files.slice(0, 20)) {
      outputs.push(
        await uploadOutput(ctx.db, ctx.ownerId, path.join(ctx.tmpDir, f), {
          filename: f,
          mimeType: mime,
          role: 'preview_frame',
        }),
      )
    }
  }
  ctx.log('extracted frames', { frames: outputs.length })
  return outputs
}

export async function createThumbnail(ctx: JobContext): Promise<OutputRef[]> {
  const input = sourceInput(ctx)
  const outPath = path.join(ctx.tmpDir, 'thumbnail.jpg')
  let args: string[]
  if (ctx.parameters.timestamp != null) {
    args = ['-y', '-ss', String(ctx.parameters.timestamp), '-i', input.localPath, '-frames:v', '1', outPath]
  } else {
    // Automatic: ffmpeg's thumbnail filter picks a representative frame.
    args = ['-y', '-i', input.localPath, '-vf', 'thumbnail', '-frames:v', '1', outPath]
  }
  const res = await runCommand('ffmpeg', args, { timeoutMs: 120_000 })
  await assertProduced(outPath, res.stderr)
  ctx.log('created thumbnail', {})
  const out = await uploadOutput(ctx.db, ctx.ownerId, outPath, {
    filename: `${baseName(input.filename)}-thumb.jpg`,
    mimeType: 'image/jpeg',
    role: 'thumbnail',
  })
  return [out]
}

export async function transcode(ctx: JobContext): Promise<OutputRef[]> {
  const input = sourceInput(ctx)
  const format = String(ctx.parameters.format ?? 'mp4').toLowerCase()
  const allowed = new Set(['mp4', 'webm', 'mov', 'mkv', 'gif'])
  if (!allowed.has(format)) throw new PermanentError(`Unsupported transcode format "${format}".`)
  const outPath = path.join(ctx.tmpDir, `out.${format}`)
  const args = ['-y', '-i', input.localPath]
  const vcodec = sanitizeCodec(ctx.parameters.video_codec)
  const acodec = sanitizeCodec(ctx.parameters.audio_codec)
  if (vcodec) args.push('-c:v', vcodec)
  if (acodec) args.push('-c:a', acodec)
  args.push(outPath)
  const res = await runCommand('ffmpeg', args, { timeoutMs: FFMPEG_TIMEOUT })
  await assertProduced(outPath, res.stderr)
  ctx.log('transcoded', { format })
  const out = await uploadOutput(ctx.db, ctx.ownerId, outPath, {
    filename: `${baseName(input.filename)}.${format}`,
    mimeType: videoMime(format),
    role: 'transcoded_video',
  })
  return [out]
}

export async function clip(ctx: JobContext): Promise<OutputRef[]> {
  const input = sourceInput(ctx)
  const start = ctx.parameters.start
  const end = ctx.parameters.end
  if (start == null || end == null) throw new PermanentError('clip needs `start` and `end` parameters (seconds or HH:MM:SS).')
  const ext = path.extname(input.filename).replace('.', '').toLowerCase() || 'mp4'
  const outPath = path.join(ctx.tmpDir, `clip.${ext}`)
  const args = ['-y', '-ss', String(start), '-to', String(end), '-i', input.localPath, '-c', 'copy', outPath]
  let res = await runCommand('ffmpeg', args, { timeoutMs: FFMPEG_TIMEOUT })
  // Stream-copy can fail on some cuts; fall back to a re-encode.
  try {
    await assertProduced(outPath, res.stderr)
  } catch {
    res = await runCommand(
      'ffmpeg',
      ['-y', '-ss', String(start), '-to', String(end), '-i', input.localPath, outPath],
      { timeoutMs: FFMPEG_TIMEOUT },
    )
    await assertProduced(outPath, res.stderr)
  }
  ctx.log('clipped', {})
  const out = await uploadOutput(ctx.db, ctx.ownerId, outPath, {
    filename: `${baseName(input.filename)}-clip.${ext}`,
    mimeType: videoMime(ext),
    role: 'video_clip',
  })
  return [out]
}

// --- helpers ---------------------------------------------------------------
function parseTimestamps(params: Record<string, unknown>): number[] {
  const raw = params.timestamps
  if (!Array.isArray(raw)) return []
  return raw
    .map((t) => (typeof t === 'number' ? t : Number(t)))
    .filter((n) => Number.isFinite(n) && n >= 0)
}
function audioSpec(format: string): { args: string[]; mime: string } | null {
  switch (format) {
    case 'wav':
      return { args: ['-acodec', 'pcm_s16le'], mime: 'audio/wav' }
    case 'mp3':
      return { args: ['-acodec', 'libmp3lame', '-q:a', '2'], mime: 'audio/mpeg' }
    case 'm4a':
      return { args: ['-acodec', 'aac', '-b:a', '192k'], mime: 'audio/mp4' }
    default:
      return null
  }
}
async function assertProduced(p: string, stderr: string): Promise<void> {
  try {
    const stat = await fs.stat(p)
    if (stat.size === 0) throw new Error('empty')
  } catch {
    throw new Error(`ffmpeg produced no output (${stderr.slice(0, 200)}).`)
  }
}
// Only allow a conservative codec allow-list — never pass arbitrary text to -c:v.
function sanitizeCodec(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const ok = new Set(['libx264', 'libx265', 'libvpx-vp9', 'libvpx', 'copy', 'aac', 'libmp3lame', 'libopus', 'copy'])
  return ok.has(v) ? v : null
}
function videoMime(ext: string): string {
  const map: Record<string, string> = {
    mp4: 'video/mp4',
    webm: 'video/webm',
    mov: 'video/quicktime',
    mkv: 'video/x-matroska',
    gif: 'image/gif',
  }
  return map[ext] ?? 'application/octet-stream'
}
function baseName(name: string): string {
  return path.basename(name, path.extname(name))
}
function clampNum(v: unknown, def: number, min: number, max: number): number {
  const n = Number(v)
  if (!Number.isFinite(n)) return def
  return Math.max(min, Math.min(max, Math.round(n)))
}
