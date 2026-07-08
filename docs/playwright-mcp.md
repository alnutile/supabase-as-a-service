# Playwright (browser automation) over MCP

This workspace can drive a real browser — navigate pages, click, fill forms, take
screenshots, read rendered content — by connecting to a **Playwright MCP server** and
re-exposing its tools everywhere: to the internal assistant/agents **and** to any external
AI (Claude Desktop, Claude Code, …) that connects to the workspace MCP endpoint.

There is no browser inside the Supabase edge runtime, so the browser itself runs in the
Playwright MCP server; the workspace is an MCP *client* to it, and an MCP *server* to your
desktop AI. Once connected, the same Playwright tools show up in both places.

## 1. Run a Playwright MCP server over HTTP

Microsoft's [`@playwright/mcp`](https://github.com/microsoft/playwright-mcp) speaks MCP and
can listen over Streamable HTTP:

```bash
npx @playwright/mcp@latest --port 8931
# → MCP endpoint at http://localhost:8931/mcp
```

Expose it on a URL the Supabase edge functions can reach (a hosted box, a tunnel, or a
managed provider such as Browserbase's hosted Playwright MCP). The workspace connects to it
by URL + an optional bearer token — the token is stored only in Supabase Vault, never in a
tool row or a log (same handling as every other external MCP server).

## 2. Connect it in the workspace

**Settings → External MCP → Add server**

- **Label:** `Playwright` (this becomes the tool-name prefix, e.g. `playwright__browser_navigate`)
- **URL:** your Playwright MCP endpoint (e.g. `https://…/mcp`)
- **Token:** the bearer token your server expects (leave blank if none)

Click **Connect & list tools** to verify the handshake and cache the toolset. This creates a
single `kind='mcp'` tool handle (the "Playwright" tool in the Tools dashboard). Activating
that handle, or scoping it to an agent via its `tool_ids`, turns the whole Playwright toolset
on or off like any other tool — and it composes with every existing gate (admin activation,
agent scoping, the `webhooks.allow_tools` lock, guardrails).

## 3. Use it

- **Internal assistant / agents / scheduler / webhooks:** the Playwright tools are wired into
  the three agent loops beside `http`/`builtin` dispatch, so "take a screenshot of
  example.com" just works once the handle is active.
- **Claude Desktop / Claude Code / other external AI:** connect to the workspace MCP endpoint
  as usual (Settings → Connect Claude for the token + snippets). The workspace MCP server's
  `tools/list` now includes the connected Playwright tools alongside the build/authoring
  tools, and calls route straight through to the Playwright server. You get one unified
  endpoint instead of wiring Playwright into every AI client separately.

## How it works

- The `_shared/mcp.ts` client discovers each connected server's toolset and namespaces every
  remote tool as `‹label›__‹remote›` (capped at 64 chars — `mcpPrefix` / `namespacedToolName`,
  both pure and unit-tested in `supabase/functions/tests/mcp_test.ts`).
- The `mcp` edge function (the server your desktop AI connects to) appends those discovered
  tools to its own `tools/list`, and in `tools/call` routes any namespaced name it doesn't
  implement itself to `runMcpTool`, which executes the call against the right server using
  that server's Vault token.
- Because the two paths share the same discovery + namespacing helpers, the tool names the
  desktop sees are exactly the ones the router can execute.

The remote tools are exfiltration-capable (a browser can reach anything), so they carry the
same workspace-wide trust as `send_email`; connecting servers stays admin-only.
