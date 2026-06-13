# Task: "Connect Claude" — show the Claude Desktop path, not just Claude Code

## Context

`SettingsPage.tsx`'s "Connect Claude (MCP)" panel (~line 406) only emits the **Claude
Code CLI** command:

```
claude mcp add --scope user --transport http intranet <mcpUrl> --header "Authorization: Bearer <token>"
```

**The problem:** `claude mcp add` configures **Claude Code**, a different product from
**Claude Desktop** (separate config stores). A Desktop user — most non-developers — runs
that command (or hand-edits `claude_desktop_config.json` wrong) and the server is
silently skipped as "not a valid MCP server configuration." Desktop launches MCP servers
as local processes, so a remote HTTP server must be bridged with `mcp-remote`.

**The goal:** the panel shows **both** connection paths, each copy-pasteable with the
user's URL and token already filled in, so either Claude connects on the first try.

## Requirements

### `src/pages/SettingsPage.tsx` — the "Connect Claude (MCP)" section

- Per generated token, replace the single command block with a small **two-tab (or two
  labeled blocks)** layout: **Claude Code** and **Claude Desktop**.
- **Claude Code** tab — unchanged command:
  ```
  claude mcp add --scope user --transport http intranet <mcpUrl> --header "Authorization: Bearer <token>"
  ```
- **Claude Desktop** tab — a copy button that copies this JSON (with `<mcpUrl>` and
  `<token>` interpolated):
  ```json
  {
    "mcpServers": {
      "intranet": {
        "command": "npx",
        "args": [
          "-y", "mcp-remote",
          "<mcpUrl>",
          "--header", "Authorization:${AUTH_HEADER}"
        ],
        "env": { "AUTH_HEADER": "Bearer <token>" }
      }
    }
  }
  ```
  with one line of helper text: "Merge into `claude_desktop_config.json` (macOS:
  `~/Library/Application Support/Claude/`), then fully quit and reopen Claude Desktop.
  Requires Node/`npx` on your PATH."
- Keep the existing copy-to-clipboard affordance and the "New connection token" /
  revoke controls as-is. Update the section's intro sentence to mention both Claude Code
  **and** Claude Desktop.
- Note the deliberate `Authorization:${AUTH_HEADER}` split (no space; value with the
  space in `env`) so a future edit doesn't "tidy" it into a broken single-line header —
  a short code comment near the JSON template is enough.

## Acceptance criteria

1. Generating a token shows both a Claude Code command and a Claude Desktop JSON block,
   each with the real URL and token filled in.
2. The Desktop JSON copies as valid JSON with the env-var header split intact.
3. Existing token generation/revocation/copy behavior is unchanged.
4. `npm run build` and `npm run lint` pass.

## Out of scope

OAuth/connector-based Desktop setup, Windows/Linux path notes beyond a brief mention,
auto-detecting which Claude the user has. Just present both snippets clearly.
