# office-worker

The OfficeCLI capability worker (`capability = office`). Polls `agent_jobs` for
office jobs and runs Word/Excel/PowerPoint operations via LibreOffice headless
(`soffice`) + poppler (`pdftoppm`) + the `docx` library. See `skills/officecli.md`
for the operation/manifest contract and `docs/capability-workers.md` for the
architecture.

## Operations

- `office.inspect_document` — structured JSON + markdown summary of a doc.
- `office.render_document` — PDF + per-page PNG previews.
- `office.create_docx` — build an editable DOCX from `instructions` (+ optional
  template/reference inputs), a preview PNG, and a validation-report artifact.
- `office.convert_document` — convert to another format (`parameters.target_format`).

## Run

Build context is the **`workers/` workspace root** (this service depends on
`@supanet/worker-shared`):

```bash
docker build -f workers/office-worker/Dockerfile -t supanet-office-worker workers
docker run --rm -p 8091:8080 \
  -e SUPABASE_URL=... -e SUPABASE_SERVICE_ROLE_KEY=... \
  -e WORKER_CAPABILITY=office supanet-office-worker
```

Environment variables: see `workers/README.md`. Health: `GET /health`, `GET /ready`.
