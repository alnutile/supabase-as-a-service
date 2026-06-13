# Task: Keep shared artifacts out of search engines (noindex)

## Context

Artifacts can be `private` (owner only), `unlisted` (anyone with the random-slug link),
or `public`. The public page is `src/pages/PublicArtifactPage.tsx`, served at
`/share/a/:slug` with no authentication (RLS returns the row for anon when
`visibility <> 'private'`).

**The problem:** the page emits no robots directive. An **unlisted** artifact is meant
to be link-only ("anyone with the link"), but if that URL ever reaches a crawler —
forwarded, pasted on a public page, a referer header, a proxy/sitemap — a search engine
can index it and it becomes publicly findable. That defeats the point of "unlisted."

**The goal:** shared artifact pages are never search-indexed unless the owner has
deliberately chosen **public**. Unlisted = link-only, and that means uncrawlable.

## Requirements

- In `PublicArtifactPage.tsx`, set a robots meta directive based on the loaded
  artifact's visibility:
  - `unlisted` → `noindex, nofollow`
  - `public` → allow indexing (no noindex), since the owner explicitly chose
    discoverable. (If you'd rather be conservative, `noindex` even for public is
    defensible — the page is still reachable by link either way; confirm with the
    maintainer. Default to the split above.)
  - Also emit `noindex, nofollow` for the loading and "isn't available" states so a
    miss is never indexed.
- Implementation: this is a Vite SPA (no SSR), so set the tag at runtime. Either inject
  a `<meta name="robots">` into `<head>` from the page effect (create/update/remove on
  unmount), or add a tiny helper — do **not** pull in a heavyweight head-management
  dependency for one tag. Crawlers that execute JS (Googlebot) honor a runtime-injected
  robots meta; for non-JS crawlers the link is unguessable anyway.
- Belt-and-suspenders (optional, recommended): add `Disallow: /share/` to a
  `public/robots.txt` (create it if absent). This stops well-behaved crawlers from
  fetching share URLs at all. Public artifacts you *want* indexed can be surfaced
  another way later; for now, link-privacy beats discoverability.

## Acceptance criteria

1. Loading an unlisted artifact page puts `<meta name="robots" content="noindex, nofollow">`
   in the document head.
2. A public artifact page does not carry `noindex` (or does, if the maintainer chose the
   conservative option).
3. Navigating away from the page removes/updates the tag (no stale directive leaks onto
   other routes).
4. `public/robots.txt` disallows `/share/` (if the optional step is taken).
5. `npm run build` and `npm run lint` pass.

## Out of scope

Changing visibility semantics, RLS, slug generation, the HTML-artifact iframe sandbox,
or adding a public gallery. This is only about crawler exposure of link-shared content.
