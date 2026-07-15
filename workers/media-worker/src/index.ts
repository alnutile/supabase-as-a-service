// media-worker — the ffmpeg capability worker. Polls agent_jobs for
// `capability = media` jobs and runs the allow-listed media operations.
import { startWorker } from '@supanet/worker-shared'
import { clip, createThumbnail, extractAudio, extractFrames, probe, transcode } from './operations.js'

const VERSION = '0.1.0'

startWorker({
  capability: 'media',
  version: VERSION,
  handlers: {
    'media.probe': probe,
    'media.extract_audio': extractAudio,
    'media.extract_frames': extractFrames,
    'media.create_thumbnail': createThumbnail,
    'media.transcode': transcode,
    'media.clip': clip,
  },
}).catch((err) => {
  console.error(JSON.stringify({ level: 'fatal', worker: 'media', error: err instanceof Error ? err.message : String(err) }))
  process.exit(1)
})
