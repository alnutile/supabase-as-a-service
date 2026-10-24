---
name: supanet-getting-started
description: >-
  Start here for SupaNet - what it is, how to point Grok at your own workspace,
  and which companion skill to load next. Use this when the user mentions SupaNet
  or their intranet but the supanet MCP tools are missing or failing to connect,
  when they ask "how do I connect my workspace", when SUPANET_MCP_URL is unset,
  or when an OAuth / 401 / "server not connected" error mentions supanet.
---

# SupaNet: connect first, then work

SupaNet (also shipped as "Intranet In A Box") is a team intranet built on
Supabase: shared AI chat, shareable **artifacts**, **collections**, **to-dos**,
**links**, **files**, real Postgres **tables**, a searchable **knowledge base**,
per-user **memory**, and an automation layer of agents, tools, webhooks and
loops. This plugin reaches it through the **`supanet` MCP server**.

**Every workspace is its own deployment.** There is no shared SupaNet endpoint
the way there is one `mcp.stripe.com` - each team runs its own Supabase project
and app domain. So the plugin's MCP URL is read from an environment variable
rather than hardcoded.

## Check whether it is connected

If `supanet` tools (`create_artifact`, `list_collections`, `search_documents`, …)
are available, you are connected - skip to
[Which skill to load next](#which-skill-to-load-next).

If they are missing, walk the user through the two steps below. Do not fall back
to describing what SupaNet *would* do; get them connected instead.

## Step 1 - set the workspace URL

The plugin resolves `${SUPANET_MCP_URL}` from the shell environment **at Grok
startup**. It must be the workspace's app domain with `/mcp` appended:

```bash
export SUPANET_MCP_URL="https://acme.supanet.io/mcp"
```

Put that in `~/.zshrc` / `~/.bashrc` so it survives new shells, then **restart
Grok** - the value is read once when the MCP server is launched, so a variable
exported after startup will not be picked up.

Finding the right domain:

- **Hosted SupaNet** - it is the domain you sign in to, e.g.
  `https://acme.supanet.io`. Workspaces are created at <https://start.supanet.io>.
- **Self-hosted** - whatever domain the SupaNet frontend is served from.
- In either case the app's **Settings → Connect Claude** page shows the exact
  connection URL for the workspace.

Use the **app domain**, not the raw `https://<project-ref>.supabase.co/functions/v1/mcp`
URL. The app domain serves the OAuth discovery documents at the root; on a shared
`*.supabase.co` host Supabase's gateway owns the root and returns 401, which
breaks discovery and registration even though the endpoints themselves work.

## Step 2 - approve the OAuth prompt

Auth is OAuth 2.1 with PKCE and dynamic client registration, so there is nothing
to paste. On first connection Grok opens the workspace's own login page; the user
signs in with their **workspace email and password** and approves. The access
token is minted against their account, expires in 30 days, and refreshes
automatically.

From then on every tool call runs **as that user**, and the workspace re-enforces
Postgres row-level security on top - the plugin grants no access the user does
not already have in the browser.

### If it still fails

| Symptom | Cause | Fix |
| --- | --- | --- |
| Server missing from `/mcps` | `SUPANET_MCP_URL` unset or exported after Grok started | Export it, restart Grok |
| `mcp_registration_failed`, OAuth discovery errors | Pointed at `*.supabase.co/functions/v1/mcp` | Use the app domain + `/mcp` |
| 401 on every call | Token expired or approval was cancelled | Reconnect from `/mcps` and approve |
| Tools listed but every call denied | RLS - this user genuinely lacks access | Ask a workspace admin; do not try to work around it |

There is also a static personal-token path (**Settings → Connect Claude** issues
one) for clients without OAuth. This plugin does not need it - prefer OAuth.

## Which skill to load next

| Load | When the task is about |
| --- | --- |
| `supanet-workspace` | the broad tour - every capability and the working rules |
| `supanet-artifacts` | docs, code, HTML pages, interactive trackers, share links |
| `supanet-collections` | grouping content, chatting with a focused set, compiled knowledge |
| `supanet-tables` | real Postgres tables and public write-forms |
| `supanet-automation` | agents, custom tools, webhooks, schedules, loops |

## The one rule

**Do the thing, don't just describe it.** If the user asks to save a doc, capture
a link, add a task, or file something into a collection, call the matching tool so
it actually lands in their workspace - then hand back the link or id. Prose alone
leaves nothing behind.
