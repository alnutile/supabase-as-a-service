# SupaNet plugin for Grok Build

Operate your **SupaNet** workspace - a self-hosted, Supabase-powered team
intranet - from Grok Build.

SupaNet (shipped as [Intranet In A Box](https://github.com/alnutile/supabase-as-a-service))
gives a team shared AI chat, shareable **artifacts**, **collections**, **to-dos**,
**links**, **files**, real Postgres **tables**, a searchable **knowledge base**,
per-user **memory**, and an automation layer of agents, tools, webhooks and
loops. This plugin connects Grok to your own workspace so work you do in the
terminal lands somewhere the rest of the team can see.

## Install

```
/plugins
```

Find **supanet** in the marketplace and install it. Then set your workspace URL
and restart Grok:

```bash
export SUPANET_MCP_URL="https://<your-workspace-domain>/mcp"
```

Run **`/supanet-connect`** if you are not sure which domain that is or the server
will not come up.

### Why a URL, and not just an install

Every SupaNet workspace is a separate deployment - your own Supabase project and
your own app domain - so there is no shared endpoint to hardcode the way a hosted
SaaS would have. The plugin reads `${SUPANET_MCP_URL}` from your environment at
Grok startup. A variable exported *after* Grok starts will not be picked up, so
put it in your shell profile.

Use the **app domain** (`https://acme.supanet.io/mcp`), not the raw
`https://<project-ref>.supabase.co/functions/v1/mcp`. The app domain serves the
OAuth discovery documents at the root; on a shared `*.supabase.co` host
Supabase's own gateway owns the root and returns 401, which breaks discovery.

Don't have a workspace yet? Create one at <https://start.supanet.io>, or
self-host from
[the repo](https://github.com/alnutile/supabase-as-a-service).

## Authentication

**OAuth 2.1 with PKCE and dynamic client registration** - there is no API key to
paste and no client ID to configure. On first connection Grok opens your own
workspace's login page; you sign in with your workspace email and password and
approve. The access token is minted against your account, expires in 30 days, and
refreshes automatically.

Login delegates to your workspace's own Supabase Auth, so the plugin never
becomes an identity provider and never sees your password. Every tool call then
runs **as you**, with Postgres row-level security applied on top - the plugin
grants no access you do not already have in the browser.

## What it ships

**MCP server** - one remote HTTP server, `supanet`, pointed at your workspace.
It exposes the workspace's own tool surface: artifacts, collections, to-dos,
links, files, tables, knowledge search, memory, planner boards, and the
automation builders.

**Skills**

| Skill | Loads when you are… |
| --- | --- |
| `supanet-getting-started` | connecting, or debugging a connection |
| `supanet-workspace` | doing anything in the workspace - the full capability map |
| `supanet-artifacts` | creating, updating, sharing or publishing documents and HTML pages |
| `supanet-collections` | organizing content, or working with the compiled knowledge layer |
| `supanet-tables` | working with Postgres tables, or building a public write-form |
| `supanet-automation` | building agents, tools, webhooks, schedules or loops |

**Commands**

| Command | Does |
| --- | --- |
| `/supanet-connect` | check the MCP server, find the right URL, walk through OAuth |
| `/supanet-save` | save a doc, notes, a file or a link into the workspace |
| `/supanet-catchup` | what changed, what is open, what needs a human |

## Network and credentials

Declared in full, per the marketplace's security expectations:

| What | Where |
| --- | --- |
| Network endpoints contacted | **only** the workspace domain you set in `SUPANET_MCP_URL` - its `/mcp` resource server and `/mcp-oauth/*` authorization server. Nothing else. |
| Credentials read | none from disk. No API key, no `.env`, no `~/.ssh`. The only input is `SUPANET_MCP_URL`. |
| Credentials issued | an OAuth access token held by Grok's own MCP client, scoped to your workspace account |
| Telemetry | none |
| Code execution | none. No hooks, no install scripts, no bundled binaries - this plugin is a manifest, an MCP URL, and markdown. |

## Links

- Product - <https://supanet.dailyai.studio>
- Documentation - <https://supanet-docs.dailyai.studio/>
- Source - <https://github.com/alnutile/supabase-as-a-service>
- Sign up - <https://start.supanet.io>

Portable versions of these skills for other agents (Claude Code, pi, Codex) live
in [supanet-skills](https://github.com/alnutile/supanet-skills), and there is a
terminal CLI at [supanet-cli](https://github.com/alnutile/supanet-cli).

## License

MIT - see [LICENSE](../LICENSE) in the repository root.
