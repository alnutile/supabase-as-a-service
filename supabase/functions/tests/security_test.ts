// Tests for the pure posture evaluator behind run_security_scan
// (_shared/security.ts). Snapshot in, findings out — no DB, no model.
import { assert, assertEquals } from 'jsr:@std/assert@1'
import { evaluatePosture, SCAN_STEPS, scanProgress, type PostureSnapshot } from '../_shared/security.ts'

// A quiet, well-configured workspace: nothing should fire.
function cleanSnapshot(): PostureSnapshot {
  return {
    webhooks: [
      {
        id: 'w1',
        name: 'CI results',
        is_active: true,
        has_secret: true,
        allow_tools: false,
        agent_id: null,
        tool_id: null,
      },
    ],
    guardrails: [
      { name: 'Prompt injection screen', applies_to_webhooks: true, applies_to_chat: false, action: 'block' },
    ],
    activeTools: [{ name: 'web_browsing', kind: 'web' }],
    emailAllowlisted: null,
    vaultSecrets: [],
    publicArtifacts: 0,
    unlistedArtifacts: 0,
    staleMcpTokens: [],
    adminCount: 2,
  }
}

function keys(s: PostureSnapshot): string[] {
  return evaluatePosture(s).map((f) => f.key)
}

Deno.test('clean posture yields no findings', () => {
  assertEquals(evaluatePosture(cleanSnapshot()), [])
})

Deno.test('active webhook without a secret fires; inactive does not', () => {
  const s = cleanSnapshot()
  s.webhooks[0].has_secret = false
  assert(keys(s).includes('webhook_no_secret:w1'))
  s.webhooks[0].is_active = false
  assertEquals(keys(s), [])
})

Deno.test('allow_tools webhook is high without a secret, medium with one', () => {
  const s = cleanSnapshot()
  s.webhooks[0].allow_tools = true
  s.webhooks[0].has_secret = false
  const noSecret = evaluatePosture(s).find((f) => f.key === 'webhook_allow_tools:w1')
  assertEquals(noSecret?.severity, 'high')

  s.webhooks[0].has_secret = true
  const withSecret = evaluatePosture(s).find((f) => f.key === 'webhook_allow_tools:w1')
  assertEquals(withSecret?.severity, 'medium')
})

Deno.test('missing blocking webhook guardrail fires per model-reaching webhook', () => {
  const s = cleanSnapshot()
  s.guardrails = []
  assert(keys(s).includes('webhook_no_guardrail:w1'))

  // flag-only guardrails do not count as coverage
  s.guardrails = [{ name: 'soft', applies_to_webhooks: true, applies_to_chat: false, action: 'flag' }]
  assert(keys(s).includes('webhook_no_guardrail:w1'))
})

Deno.test('direct-function webhooks (tool_id) skip model-path checks but keep the secret check', () => {
  const s = cleanSnapshot()
  s.guardrails = []
  s.webhooks[0].tool_id = 't1'
  s.webhooks[0].allow_tools = true
  s.webhooks[0].has_secret = false
  const found = keys(s)
  assert(!found.includes('webhook_no_guardrail:w1'))
  assert(!found.includes('webhook_allow_tools:w1'))
  assert(found.includes('webhook_no_secret:w1'))
})

Deno.test('send_email without an allowlist fires only when the tool is active', () => {
  const s = cleanSnapshot()
  s.emailAllowlisted = false
  assert(!keys(s).includes('send_email_no_allowlist')) // tool not active

  s.activeTools.push({ name: 'send_email', kind: 'builtin' })
  assert(keys(s).includes('send_email_no_allowlist'))

  s.emailAllowlisted = true
  assert(!keys(s).includes('send_email_no_allowlist'))
})

Deno.test('get_secret + workspace-scoped secrets fires; private-only stays quiet', () => {
  const s = cleanSnapshot()
  s.activeTools.push({ name: 'get_secret', kind: 'builtin' })
  s.vaultSecrets = [{ name: 'ci_token', scope: 'private' }]
  assert(!keys(s).includes('get_secret_workspace'))

  s.vaultSecrets.push({ name: 'shared_api_key', scope: 'workspace' })
  assert(keys(s).includes('get_secret_workspace'))
})

Deno.test('active MCP handles, stale tokens, public artifacts, single admin', () => {
  const s = cleanSnapshot()
  s.activeTools.push({ name: 'zapier', kind: 'mcp' })
  s.staleMcpTokens = [{ name: 'old laptop', days: 120 }]
  s.publicArtifacts = 3
  s.unlistedArtifacts = 1
  s.adminCount = 1
  const found = keys(s)
  assert(found.includes('mcp_servers_active'))
  assert(found.includes('stale_mcp_token:old laptop'))
  assert(found.includes('public_artifacts'))
  assert(found.includes('single_admin'))
})

Deno.test('findings sort by severity, most severe first', () => {
  const s = cleanSnapshot()
  s.adminCount = 1 // info
  s.webhooks[0].has_secret = false // medium
  s.webhooks[0].allow_tools = true // high (no secret)
  const sevs = evaluatePosture(s).map((f) => f.severity)
  const order = ['critical', 'high', 'medium', 'low', 'info']
  const sorted = [...sevs].sort((a, b) => order.indexOf(a) - order.indexOf(b))
  assertEquals(sevs, sorted)
})

Deno.test('scanProgress marks earlier steps done, current running, rest pending', () => {
  const start = scanProgress(0)
  assertEquals(start.length, SCAN_STEPS.length)
  assertEquals(start[0].status, 'running')
  assert(start.slice(1).every((s) => s.status === 'pending'))

  const mid = scanProgress(2)
  assertEquals(mid.map((s) => s.status), ['done', 'done', 'running', 'pending'])

  const finished = scanProgress(SCAN_STEPS.length)
  assert(finished.every((s) => s.status === 'done'))
  // Keys are stable + unique — the dashboard uses them as list keys.
  assertEquals(new Set(finished.map((s) => s.key)).size, SCAN_STEPS.length)
})
