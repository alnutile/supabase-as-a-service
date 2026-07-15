# Skill: office-document-worker (capability = `office`)

Word / Excel / PowerPoint work, run by the **office-worker** (LibreOffice headless
`soffice` for convert/render, `pdftoppm` for PDF→PNG previews, the `docx` library
to author). Builds on `capability-workers.md` for the shared job lifecycle; this
document adds the office operations. Implemented in
`workers/office-worker/src/operations.ts`.

## Supported operations

| operation | input | output |
| --- | --- | --- |
| `office.inspect_document` | docx / xlsx / pptx (etc.) | structured JSON file + a markdown summary artifact |
| `office.render_document` | docx / xlsx / pptx | PDF + one PNG preview per page (capped) |
| `office.create_docx` | `instructions` (document body) + optional reference files | editable DOCX + rendered PNG preview + validation-report artifact |
| `office.convert_document` | any office doc | converted file in the target format (`parameters.target_format`) |

There is deliberately **no** `office.run_command` — operations are narrow and
allow-listed.

## Accepted input types

`docx, doc, xlsx, xls, pptx, ppt, odt, ods, odp`. Anything else → a permanent
`failed` with an actionable message.

## Input manifest

Reference files by `file_id` (preferred). Roles:

- `template` — required for `create_docx`.
- `reference` — supporting material.
- `source` — the document to inspect/render/convert.

```json
{
  "operation": "office.create_docx",
  "instructions": "# Acme Proposal\n\n## Discovery\n…\n\n## Pricing\n…",
  "input_manifest": [
    { "file_id": "<template>", "role": "template", "required": true },
    { "file_id": "<rate-card>", "role": "reference", "required": true }
  ]
}
```

The worker has no LLM: the main AI supplies the document body in `instructions`
(`# heading` lines become headings, blank lines split paragraphs).

## Output manifest

```json
[
  { "file_id": "…", "role": "editable_document",  "filename": "acme-proposal.docx" },
  { "file_id": "…", "role": "rendered_preview",   "filename": "acme-proposal-preview.png" },
  { "artifact_id": "…", "role": "validation_report", "type": "artifact" }
]
```

## Invocation & cleanup rules

- Conversions/renders go through `soffice --headless --convert-to …` into a fresh
  per-job temp dir; the output file's existence is verified (soffice's exit code
  is unreliable).
- Previews: DOCX/office → PDF → PNG via `pdftoppm` (capped pages).
- All inputs are re-verified to belong to the job owner before download.
- Temp files are deleted after completion (success or failure).
- A preview-render failure does not fail `create_docx` — the DOCX is still
  returned, and the validation report notes the skipped preview.

## Failure behavior

- Unsupported file type / missing required input → `failed` (permanent).
- Transient storage/soffice errors → `retrying` with backoff.
- After `max_attempts` → `dead_letter`.

## How the main AI presents results

Offer the editable DOCX, show the preview PNG, and give the short validation
report. Creating/converting a document is safe (writes only to Files/Storage) — no
confirmation needed. Only sharing externally requires explicit approval.
