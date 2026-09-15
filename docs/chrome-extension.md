# Chrome extension (web clipper)

Save the page you are looking at into your workspace — as a **bookmark** (a
`links` row, metadata fetched server-side) or as a **markdown artifact** (the
article, converted from HTML, page furniture stripped) — and file it into a
**collection** on the way in.

It lives in [`extension/`](../extension) and is a plain, **unbundled** MV3
extension: no build step, no npm install, no framework. `chrome://extensions`
→ *Load unpacked* → pick the folder and it runs. That is deliberate — the thing
you side-load in dev mode is byte-for-byte the thing that gets zipped for the
Web Store, so there is no "works in dev, broken in the store" gap.

## Install (developer mode)

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. **Load unpacked** → select the `extension/` folder of this repo.
4. Pin *Save to SupaNet* to the toolbar. `Ctrl/Cmd + Shift + S` opens it too.

To publish later: zip the contents of `extension/` (the manifest must be at the
top level of the zip, not inside a folder) and upload it in the Chrome Web
Store developer dashboard. Bump `version` in `manifest.json` for each upload.

## Connect it

The popup asks for two things the first time:

| Field | What to enter |
| --- | --- |
| **Supabase project URL** | `https://‹project›.supabase.co`. Pasting a full endpoint URL (`…/functions/v1/run-tool`) works — it is trimmed back to the origin. |
| **Connection token** | A personal token from **Settings → Connect Claude** in the app (an `mcp_tokens` row) — the same one the MCP server and the `supanet` CLI use. |
| **Workspace URL** *(optional)* | Your intranet's own address, e.g. `https://intranet.example.com`. Only used to turn "Saved." into a link you can click. |

**Connect** verifies the pair with a real round-trip (`GET /run-tool/list`)
before storing anything, so a typo fails at setup rather than at the first save.

Everything the extension does runs **as that token's owner**: the edge
functions resolve the bearer through `_shared/apiauth.ts` and re-enforce
ownership in code, so the extension can never reach data you could not reach in
the browser. Revoke the token in the same Settings page to cut it off.

The token is stored in `chrome.storage.local`, not `chrome.storage.sync` — it
is a credential, and `sync` would copy it to every Chrome profile signed into
the same Google account.

## Saving a page

Open the popup on any page and pick one of:

- **Page as article** — the page's rendered HTML is read, the article is found,
  and the result is stored as a `markdown` artifact. The mode label shows the
  word count *before* you save ("1,240 words of markdown, no page furniture"),
  and **Preview the markdown** shows what will be stored, so a page the
  extractor got wrong is obvious in advance rather than after the fact.
- **Just the link** — a `links` row via the `save_link` builtin, which fetches
  the page's own title, description, `og:image` and favicon server-side, so the
  card looks the same as one added by hand in the app.

Either mode takes a **collection** (existing, or `+ New collection…` to create
one by name) and an optional **note**. A note on a link becomes the link's
`notes`; a note on an article is appended to the artifact body.

The saved artifact leads with its provenance:

```markdown
> Saved from [example.com/posts/rls](https://example.com/posts/rls) on 2026-09-15
> By Ada Lovelace
>
> What policies actually enforce.

---

The article, as markdown…
```

That header is the point of clipping into artifacts rather than into a pile of
raw HTML: a collection you chat with, and the knowledge compiler that runs over
it, can both point back at where a claim came from.

## How it talks to the workspace

**It adds no server-side endpoint.** Every call goes through a surface that
already exists and is already documented:

| What | Call |
| --- | --- |
| Verify the connection | `GET /functions/v1/run-tool/list` |
| List collections | `POST /functions/v1/run-tool` → `list_collections` |
| Save a bookmark | `POST /functions/v1/run-tool` → `save_link` |
| Save an artifact | `POST /functions/v1/artifacts` ([reference](artifacts-api.md)) |

This is the same rule the [`supanet` CLI](https://github.com/alnutile/supanet-cli)
follows: if the clipper needs something new, the fix belongs in `run-tool` or
the REST functions in this repo, **not** in a bespoke endpoint for one client.
Because `run-tool` returns a tool's *text* result, the two small parsers that
read it back (`parseCollectionList`, `parseSaveLinkResult`) live in
`extension/lib/parse.js` and are unit-tested — a wording change in a builtin
degrades to an empty collection picker, never to a broken popup.

No edge function had to change for any of this.

## Permissions

`activeTab`, `scripting`, `storage` — and **no host permissions at all**.

- `activeTab` + `scripting`: the page is read only when *you* open the popup,
  and only the tab you opened it on. Nothing is injected into anything else,
  and there is no content script running in the background.
- No `host_permissions`: the calls to your Supabase project work through
  ordinary CORS (both functions answer `Access-Control-Allow-Origin: *`), so
  the extension never asks to "read and change your data on all sites".

The injected snippet is deliberately trivial — it hands back
`document.documentElement.outerHTML` and nothing else. All the parsing happens
in the popup, which is what keeps it testable outside Chrome.

## How the article extraction works

`extension/lib/extract.js` is a readability-style scorer, not a list of
per-site selectors. Every plausible container is scored by how much *prose* it
holds (paragraph text length with diminishing returns, plus sentence
punctuation), penalised by its link density (a nav or a "related posts" rail is
mostly links), and nudged by its class/id name. Sites change their markup
constantly; a heuristic degrades to "a bit more chrome than ideal", while a
selector list degrades to "saved nothing".

`extension/lib/markdown.js` then converts that subtree: headings, lists
(nested), fenced code with the language sniffed off the `class`, blockquotes,
GFM tables, figures with captions, and links/images resolved to absolute URLs.
Junk-named blocks are dropped in two tiers — names with only one meaning
(`catlinks`, `disqus`, `share`) go at any size, ambiguous ones (`sidebar`,
`promo`, `ad`) only when small — and **no element holding more than 60% of the
page's text is ever dropped**, so one unlucky class name on a wrapper can't
clip the whole article away.

The workspace already has an HTML→markdown converter for the `http_request`
builtin (`supabase/functions/_shared/html_markdown.ts`), but it runs on
HTML *the server fetched*. An extension exists precisely because the server
cannot fetch what you are looking at — a logged-in page, something behind a
subscription you pay for, a client-rendered SPA — so the conversion has to
happen against the live DOM.

## Tests

The pure logic is unit-tested with the app's own `vitest` (jsdom gives the
tests a real `DOMParser`), and runs as part of `npm test`:

```bash
npm test                      # the whole suite, extension included
npx vitest run extension/     # just the extension
```

`extension/lib/*.test.js` covers the markdown conversion, the content scorer,
the connection/bearer handling and the two run-tool text parsers. The popup
itself is wiring only, on purpose.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| "Chrome will not let an extension read this page." | `chrome://`, the Web Store, and other privileged pages can't be scripted by any extension. The popup falls back to link mode. |
| "That token was rejected." | The token was revoked or belongs to another project. Mint a new one in Settings → Connect Claude. |
| "Could not reach https://…" | Wrong project URL, or the project is paused. |
| "only 12 words found — check the preview" | The page is a client-rendered shell that hadn't painted, or the extractor missed. Check the preview; save it as a link instead. |
| Collections dropdown is empty | `list_collections` is a builtin tool — an admin can confirm it is active on the Tools page. |
| Saving a link fails but an artifact works | The `save_link` builtin isn't active in that workspace. The setup step says so when it connects. |

## Icons

`extension/icons/*.png` are generated from the same mark as `public/favicon.svg`
by `extension/icons/generate-icons.py` (stdlib only — Chrome will not accept an
SVG icon). Re-run it after changing the mark:

```bash
python3 extension/icons/generate-icons.py
```
