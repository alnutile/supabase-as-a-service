# media-worker

The ffmpeg capability worker (`capability = media`). Polls `agent_jobs` for media
jobs and runs audio/video operations via `ffmpeg` + `ffprobe`. See
`skills/ffmpeg.md` for the operation/manifest contract and
`docs/capability-workers.md` for the architecture.

## Operations

- `media.probe` — duration, dimensions, codecs, fps, streams (as a metadata artifact).
- `media.extract_audio` — audio track to wav/mp3/m4a.
- `media.extract_frames` — frames at timestamps or an interval (capped at 20).
- `media.create_thumbnail` — one representative thumbnail.
- `media.transcode` — re-encode to mp4/webm/mov/mkv/gif (allow-listed codecs).
- `media.clip` — cut a `start`–`end` segment.

## Run

Build context is the **`workers/` workspace root** (this service depends on
`@supanet/worker-shared`):

```bash
docker build -f workers/media-worker/Dockerfile -t supanet-media-worker workers
docker run --rm -p 8092:8080 \
  -e SUPABASE_URL=... -e SUPABASE_SERVICE_ROLE_KEY=... \
  -e WORKER_CAPABILITY=media supanet-media-worker
```

Environment variables: see `workers/README.md`. Health: `GET /health`, `GET /ready`.
