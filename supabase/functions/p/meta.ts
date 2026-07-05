// HTML assembly for the standalone artifact page — extracted from index.ts so
// the injection/escaping behavior is unit-testable (the `</script>`-in-state
// escape below is load-bearing: artifact `data` is user/AI-authored).

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// Inject <title> + OpenGraph tags so the public link unfurls nicely. If the
// HTML already has a <head>, splice the meta in; otherwise wrap a minimal doc.
// Also injects the artifact's saved interactive state as
// `window.__ARTIFACT_DATA__` — standalone pages have no parent app to answer
// the postMessage bridge, so a live tracker's checked boxes/statuses still
// render here (read-only: with no session there's nothing to persist to).
export function withMeta(html: string, title: string, data: unknown): string {
  const t = escapeHtml(title || 'Shared page')
  const hasTitle = /<title[\s>]/i.test(html)
  // <-escape so a `</script>` inside the JSON can't break out of the tag.
  const stateJson = JSON.stringify(data ?? {}).replace(/</g, '\\u003c')
  const meta =
    (hasTitle ? '' : `<title>${t}</title>`) +
    `<meta property="og:title" content="${t}">` +
    `<meta property="og:type" content="website">` +
    `<meta name="twitter:card" content="summary_large_image">` +
    `<script>window.__ARTIFACT_DATA__=${stateJson}</script>`

  if (/<head[\s>]/i.test(html)) {
    return html.replace(/<head([^>]*)>/i, `<head$1>${meta}`)
  }
  if (/<html[\s>]/i.test(html)) {
    return html.replace(/<html([^>]*)>/i, `<html$1><head>${meta}</head>`)
  }
  return `<!doctype html><html><head><meta charset="utf-8">${meta}</head><body>${html}</body></html>`
}
