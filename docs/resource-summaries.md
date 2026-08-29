# Resource summaries

`summarize_resource` is the shared AI summarization capability. It resolves a
resource as the calling user, extracts supported content, calls the configured
`utility` model with no tools, caches the result by source version, and can
write the result to a safe description field.

## Supported sources

- `link` — ordinary web pages and Dropbox file/share links
- `file` — workspace files
- `artifact`
- `inbox_message`
- `knowledge_page`
- `text` — direct supplied text

Text/Markdown/CSV/JSON/source files, PDFs, and common image formats are
supported. Downloads are capped at 8 MB and extracted text at 60,000
characters. Office documents, audio/video, scanned PDFs, and Dropbox folders
should use the capability-worker pipeline instead.

## Direct API

The tool is available through the existing `run-tool` endpoint:

```json
{
  "tool": "summarize_resource",
  "input": {
    "source_kind": "link",
    "source_id": "LINK_UUID",
    "style": "tldr",
    "max_words": 80,
    "write_back": true
  }
}
```

`style` is `tldr`, `brief`, or `detailed`. Set `refresh:true` to bypass a
matching cached result. `write_back:true` updates `links.description` or
`files.description`; other source kinds return/cache the summary without
modifying the source.

## Agents and listeners

The seeded builtin is an ordinary Tools row, so it can be attached to an agent.
A deterministic event listener can summarize every newly saved link with:

- event: `link.created`
- action: `run_tool`
- tool: `summarize_resource`
- input:

```json
{
  "source_kind": "link",
  "source_id": "{{event.entity_id}}",
  "style": "tldr",
  "write_back": true
}
```

Dropbox links also run this automatically from the Links page after metadata is
filled. Adding uses the cache; explicitly refreshing the link regenerates the
summary.

## Safety and accounting

Source access is re-checked as the caller even though builtin execution uses the
service role. Dropbox credentials remain in Vault. Resource content is marked
as untrusted, the model receives no tools, and content is not written to logs.
Model usage is recorded with context `summary`. Cached summaries are
owner-private and emit `summary.created` / `summary.updated` events.
