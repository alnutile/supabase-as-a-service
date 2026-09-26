# Grok Build plugin (`grok-plugin/`)

The SupaNet plugin for the **xAI plugin marketplace**, so a Grok Build user can
install `supanet` and drive their workspace from the terminal.

## Which marketplace this is

The catalog at [`xai-org/plugin-marketplace`](https://github.com/xai-org/plugin-marketplace)
is for **Grok Build** - the coding CLI/IDE agent - not Grok Bot. xAI's
announcement is explicit: "the Grok Build Plugin Marketplace - a set of built-in
plugins for Grok Build", and "if you've built a plugin you want to share, submit
a pull request to xai-org/plugin-marketplace". Grok Bot templates are a separate
distribution surface with a separate flow; nothing here targets it.

## Layout

A Grok plugin is a directory. Grok discovers components by convention, and the
manifest only adds metadata:

```
grok-plugin/
├── .grok-plugin/plugin.json   manifest (name, version, description, author, keywords)
├── .mcp.json                  the remote MCP server
├── README.md                  install, auth, declared network/credential surface
├── commands/*.md              slash commands (frontmatter: description, argument-hint)
└── skills/<name>/SKILL.md     skills (frontmatter: name, description)
```

`hooks/hooks.json` and `.lsp.json` are also supported by the format. This plugin
deliberately ships **neither** - no lifecycle hooks and no code execution at all,
which is the single biggest thing marketplace review looks at.

## The MCP URL is an environment variable, on purpose

Every hosted plugin in the catalog points at one shared endpoint
(`mcp.stripe.com`, `mcp.neon.tech`, …). SupaNet cannot: each workspace is its own
Supabase project and its own app domain, so there is no URL to hardcode.

Grok expands `${VAR}` and `${VAR:-default}` in an MCP server's `url`, `command`,
`args`, `env` and `headers`, so `.mcp.json` reads:

```json
{ "mcpServers": { "supanet": { "type": "http", "url": "${SUPANET_MCP_URL}" } } }
```

There is **no default**. A wrong default would silently point a user's OAuth
approval at someone else's workspace, which is worse than a server that fails to
start with an obvious cause. `/supanet-connect` and the `supanet-getting-started`
skill both cover diagnosing it.

Two things to tell users, because they are the two support questions:

1. The variable is read **once, at Grok startup**. Exporting it afterwards does
   nothing.
2. It must be the **app domain** plus `/mcp`, not
   `https://<ref>.supabase.co/functions/v1/mcp`. The app's own `server.js` serves
   the OAuth discovery documents at the root; on a shared `*.supabase.co` host
   Supabase's gateway owns the root and returns 401, so discovery and dynamic
   client registration fail even though the endpoints themselves work. See
   [`mcp-oauth.md`](./mcp-oauth.md).

Auth needs nothing else: the `mcp-oauth` edge function is a full OAuth 2.1 + PKCE
authorization server with RFC 7591 dynamic client registration, so Grok
self-registers and the user just signs in and approves.

## Submitting to the marketplace

The marketplace repo is an **index**. A PR adds one entry to
`.grok-plugin/marketplace.json` pointing at this repo and a pinned commit;
nothing is vendored there.

1. Land the plugin changes on `main` here, so the commit you pin is public and
   reachable. CI on the marketplace repo fetches it - a private repo or a
   force-pushed-away commit fails the build loudly.
2. Generate the catalog entry with the SHA already pinned:
   ```bash
   node scripts/grok-marketplace-entry.mjs            # pins origin/main
   node scripts/grok-marketplace-entry.mjs <sha>      # pins a specific commit
   ```
   It resolves the SHA from the **remote**, not the local clone, so you cannot
   pin a commit that has not been pushed.
3. Fork `xai-org/plugin-marketplace`, branch from `main`, and append the entry to
   the `plugins` array in `.grok-plugin/marketplace.json`.
4. Regenerate the component index and validate - this is exactly what their CI
   runs:
   ```bash
   python3 scripts/generate-plugin-index.py
   python3 scripts/validate-catalog.py
   python3 scripts/generate-plugin-index.py --check
   ```
   Never hand-edit `plugin-index.json`; a stale one fails CI.
5. Open the PR. CI plus code-owner review gate it.

**To ship an update**, bump the `sha` on the existing entry and regenerate the
index. Do not open a second, parallel entry.

### Known review risk

Their contributing guide asks for a plugin to be sourced from the product's
official org rather than a personal account - a branded plugin sourced from a
personal account "reads as a possible impersonation and *will* be questioned".
This repo currently lives under a personal account (`alnutile`) while the plugin
is branded SupaNet / DailyAI Studio. Moving the source under a DailyAI org, or
being ready to explain the ownership on the PR, is the fastest path through
review. Everything else in the checklist is already satisfied: pinned SHA, a
README with a declared network and credential surface, a homepage, a stated MIT
license, and brand-scoped keywords and domains.

## Testing locally before submitting

```bash
mkdir -p ~/.grok/plugins
ln -s "$PWD/grok-plugin" ~/.grok/plugins/supanet
export SUPANET_MCP_URL="https://<your-workspace-domain>/mcp"
grok
```

Then in the session: `/plugins` and `/mcps` to confirm the plugin and server
loaded, `/supanet-connect` to walk the OAuth flow, and a `list_collections` call
to confirm the tools work end to end.

## Keeping it honest

`src/lib/grokPlugin.test.ts` guards the structure - valid JSON, required manifest
fields, every skill and command carrying frontmatter, and the `.mcp.json` URL
staying an environment variable rather than a hardcoded tenant. It runs in
`npm test` with the rest of the suite.

The skills here overlap with the portable set in
[`supanet-skills`](https://github.com/alnutile/supanet-skills) and the in-repo
`.claude/skills/`. That duplication is inherent to the plugin format - a
marketplace plugin has to be self-contained from one pinned commit, it cannot
tell users to go install a second repo. **When a feature changes shape (a tool's
name or arguments, an endpoint, the artifact protocol), update all three.**
