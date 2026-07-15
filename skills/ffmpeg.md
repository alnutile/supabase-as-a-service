# Skill: media-ffmpeg-worker (capability = `media`)

Audio / video processing, run by the **media-worker** (ffmpeg + ffprobe). Builds
on `capability-workers.md` for the shared job lifecycle; this document adds the
media operations. Implemented in `workers/media-worker/src/operations.ts`.

The media worker proves the same job protocol works for a completely different
library without changing the orchestration layer.

## Supported operations

| operation | input | parameters | output |
| --- | --- | --- | --- |
| `media.probe` | video/audio | — | media-metadata artifact (duration, dims, codecs, fps, streams) |
| `media.extract_audio` | video | `{format: wav\|mp3\|m4a}` | audio file |
| `media.extract_frames` | video | `{timestamps:[…]}` or `{interval}` + `{format: png\|jpg}` | frame images (capped at 20) |
| `media.create_thumbnail` | video | `{timestamp}` or automatic | one thumbnail image |
| `media.transcode` | video | `{format: mp4\|webm\|mov\|mkv\|gif, video_codec?, audio_codec?}` | transcoded video |
| `media.clip` | video | `{start, end}` (seconds or `HH:MM:SS`) | video clip |

There is deliberately **no** arbitrary-ffmpeg-argument operation. Codec names are
checked against a conservative allow-list; timestamps/formats come through typed
parameters, never a raw argument string.

## Input manifest

Reference the media by `file_id`, role `source_video` / `source` (required).

```json
{
  "operation": "media.extract_frames",
  "instructions": "Extract five representative frames for a video preview.",
  "input_manifest": [ { "file_id": "<video>", "role": "source_video", "required": true } ],
  "parameters": { "timestamps": [0, 15, 30, 45, 60], "format": "png" }
}
```

## Output manifest

```json
[
  { "file_id": "…", "role": "preview_frame", "filename": "frame-001.png" },
  { "file_id": "…", "role": "preview_frame", "filename": "frame-002.png" },
  { "artifact_id": "…", "role": "media_metadata", "type": "artifact" }
]
```

## Invocation & cleanup rules

- `ffprobe -print_format json` for metadata; `ffmpeg` for extraction/transcode/
  clip, each into a fresh per-job temp dir with output-size verification.
- `media.clip` tries a fast stream-copy cut first, then falls back to a re-encode.
- Inputs are re-verified to belong to the job owner; temp files are deleted after
  completion.

## Failure behavior

- Unreadable/unsupported media, missing `start`/`end`, unsupported format →
  `failed` (permanent).
- Transient ffmpeg/storage errors → `retrying` with backoff; past `max_attempts`
  → `dead_letter`.

## How the main AI presents results

Show the frames/thumbnail/clip; if a probe ran, summarize the media metadata.
