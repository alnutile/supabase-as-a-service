// deno test — the pure namespacing helpers that map a connected external MCP
// server's remote tool to a single, stable, function-name-safe identifier. Both
// the agent-loop expansion (expandMcpTools) and the MCP server that re-exposes
// these tools to an external Claude (Desktop / Code) must agree on the exact same
// name, so the Playwright tools the desktop sees are the ones the router executes.
import { assertEquals } from 'jsr:@std/assert@1'
import { mcpPrefix, namespacedToolName } from '../_shared/mcp.ts'

Deno.test('mcpPrefix: lowercases and slugs to a safe prefix', () => {
  assertEquals(mcpPrefix('Playwright'), 'playwright')
  assertEquals(mcpPrefix('Zapier MCP'), 'zapier_mcp')
  assertEquals(mcpPrefix('  Browser-Bot!  '), 'browser_bot')
  assertEquals(mcpPrefix(''), 'mcp') // empty falls back to a usable prefix
  assertEquals(mcpPrefix('***'), 'mcp') // no alnum chars → fallback
})

Deno.test('namespacedToolName: joins label + remote with the separator', () => {
  assertEquals(namespacedToolName('Playwright', 'browser_navigate'), 'playwright__browser_navigate')
  assertEquals(namespacedToolName('Zapier MCP', 'gmail_find_email'), 'zapier_mcp__gmail_find_email')
})

Deno.test('namespacedToolName: caps at 64 chars (OpenAI/OpenRouter limit)', () => {
  const name = namespacedToolName('playwright', 'a'.repeat(200))
  assertEquals(name.length, 64)
  assertEquals(name.startsWith('playwright__aaaa'), true)
})
