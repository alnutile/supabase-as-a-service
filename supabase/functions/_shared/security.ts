// The workspace security posture scan behind the `run_security_scan` builtin
// (Governance → Security dashboard; seeded in migration 0056).
//
// Split on purpose, following the repo's extract-pure-logic pattern:
//   * gatherPosture(db)      — service-role queries → a plain PostureSnapshot.
//   * evaluatePosture(snap)  — PURE function snapshot → findings. This is the
//                              part with judgment in it, so it's the part with
//                              tests (supabase/functions/tests/security_test.ts).
//   * runSecurityScan(db,id) — orchestration, in security_scan.ts: admin gate,
//                              scan row lifecycle, status carry-over for
//                              re-runs, one best-effort utility-model call for
//                              the prose summary.
//
// The FINDINGS are deterministic — config facts, not model opinions — so a
// daily scheduled run costs at most one cheap utility-model call (the summary),
// and even that fails open to a computed summary. Enforcement/judgment stays in
// code, same philosophy as guardrails.
//
// This module has NO imports — not even dynamic ones. Deno type-checks dynamic
// import specifiers too, and the models/openrouter/usage graph pulls in npm:
// packages + Deno.env reads; keeping this file import-free is what lets the
// tests run with no node_modules and no env access (CI's edge job has neither).
// The model-touching half lives in security_scan.ts.

// deno-lint-ignore no-explicit-any
type DB = any

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info'

export interface Finding {
  key: string // stable across runs → dismissed/promoted status carries over
  severity: Severity
  title: string
  detail: string
  suggestion: string
}

export interface PostureSnapshot {
  webhooks: Array<{
    id: string
    name: string
    is_active: boolean
    has_secret: boolean
    allow_tools: boolean
    agent_id: string | null
    tool_id: string | null
  }>
  // Active guardrails only.
  guardrails: Array<{ name: string; applies_to_webhooks: boolean; applies_to_chat: boolean; action: string }>
  // Active tools only (name + kind is enough to reason about exposure).
  activeTools: Array<{ name: string; kind: string }>
  emailAllowlisted: boolean | null // null = email not configured
  vaultSecrets: Array<{ name: string; scope: string }>
  publicArtifacts: number
  unlistedArtifacts: number
  staleMcpTokens: Array<{ name: string; days: number }>
  adminCount: number
}

const SEVERITY_ORDER: Severity[] = ['critical', 'high', 'medium', 'low', 'info']

// --- Live progress -----------------------------------------------------------
// The scan row's `progress` jsonb is this ordered checklist; runSecurityScan
// re-writes it as it moves through the steps and the dashboard follows the row
// over Realtime. Pure on purpose (like evaluatePosture) so it's unit-testable.

export type StepStatus = 'pending' | 'running' | 'done'

export interface ProgressStep {
  key: string
  label: string
  status: StepStatus
}

export const SCAN_STEPS: ReadonlyArray<{ key: string; label: string }> = [
  { key: 'gather', label: 'Collecting workspace configuration' },
  { key: 'evaluate', label: 'Running the posture checks' },
  { key: 'save', label: 'Saving findings (carrying over triage)' },
  { key: 'summarize', label: 'Writing the summary' },
]

// Checklist with everything before `current` done, `current` running, and the
// rest pending. `current >= SCAN_STEPS.length` marks the whole list done.
export function scanProgress(current: number): ProgressStep[] {
  return SCAN_STEPS.map((s, i) => ({
    ...s,
    status: i < current ? 'done' : i === current ? 'running' : 'pending',
  }))
}

export function evaluatePosture(s: PostureSnapshot): Finding[] {
  const findings: Finding[] = []
  const activeNames = new Set(s.activeTools.map((t) => t.name))

  const webhookGuardrailBlocks = s.guardrails.some((g) => g.applies_to_webhooks && g.action === 'block')

  for (const w of s.webhooks) {
    if (!w.is_active) continue
    // Direct-function webhooks (tool_id) never reach a model; schema validation
    // is their gate, so only the secret check applies to them.
    const reachesModel = !w.tool_id
    if (w.allow_tools && reachesModel) {
      findings.push({
        key: `webhook_allow_tools:${w.id}`,
        severity: w.has_secret ? 'medium' : 'high',
        title: `Webhook "${w.name}" can run tools on untrusted input`,
        detail: w.has_secret
          ? `This webhook's agent runs with tools enabled (allow_tools). It requires a shared secret, so only holders of the secret can trigger it — but whatever they send still steers a tool-wielding agent.`
          : `This webhook's agent runs with tools enabled (allow_tools) and has NO shared secret — anyone who learns the URL can make a tool-wielding agent act on their payload.`,
        suggestion: w.has_secret
          ? `Confirm the tool set scoped to this webhook's agent is the minimum it needs; keep exfiltration-capable tools (send_email, get_secret, MCP servers, http_request) off it.`
          : `Set a shared secret on this webhook (editor → "Require a secret"), or turn allow_tools off so it runs read-only.`,
      })
    }
    if (!w.has_secret) {
      findings.push({
        key: `webhook_no_secret:${w.id}`,
        severity: 'medium',
        title: `Webhook "${w.name}" has no shared secret`,
        detail: `The only protection is the opaque token in the URL. URLs leak — logs, browser history, pasted configs — and a leaked URL is full access to this webhook.`,
        suggestion: `Set a shared secret in the webhook editor; callers then need an Authorization: Bearer header, and wrong callers are rejected before anything is logged or run.`,
      })
    }
    if (reachesModel && !webhookGuardrailBlocks) {
      findings.push({
        key: `webhook_no_guardrail:${w.id}`,
        severity: 'high',
        title: `No blocking guardrail screens webhook "${w.name}"`,
        detail: `This webhook feeds external payloads to a model, but no active guardrail with action=block applies to webhooks — prompt-injection attempts reach the agent unscreened.`,
        suggestion: `Re-enable the built-in "Prompt injection screen" guardrail (Governance → Guardrails) or add a blocking webhook guardrail.`,
      })
    }
  }

  if (activeNames.has('send_email') && s.emailAllowlisted === false) {
    findings.push({
      key: 'send_email_no_allowlist',
      severity: 'medium',
      title: 'send_email is active with no recipient allowlist',
      detail: `Any agent loop that can call send_email can mail ANY address. Combined with untrusted input (webhooks, pasted content), that is a data-exfiltration channel; the 20/hour rate limit bounds volume, not damage.`,
      suggestion: `Settings → Email: set allowed recipients (exact addresses or @yourdomain suffixes) so mail can only go where you expect.`,
    })
  }

  if (activeNames.has('get_secret')) {
    const workspaceSecrets = s.vaultSecrets.filter((v) => v.scope === 'workspace')
    if (workspaceSecrets.length > 0) {
      findings.push({
        key: 'get_secret_workspace',
        severity: 'low',
        title: `get_secret is active with ${workspaceSecrets.length} workspace-shared secret${workspaceSecrets.length === 1 ? '' : 's'}`,
        detail: `Workspace-scoped vault secrets (${workspaceSecrets.map((v) => v.name).join(', ')}) are readable by every member and any agent with the get_secret tool. Each read is activity-logged, but a read puts the raw credential into a conversation.`,
        suggestion: `Keep secrets private-scoped unless the whole team genuinely needs them, and scope get_secret to specific agents via tool_ids instead of leaving it globally active.`,
      })
    }
  }

  const mcpTools = s.activeTools.filter((t) => t.kind === 'mcp')
  if (mcpTools.length > 0) {
    findings.push({
      key: 'mcp_servers_active',
      severity: 'low',
      title: `${mcpTools.length} external MCP server${mcpTools.length === 1 ? ' is' : 's are'} active`,
      detail: `Active MCP handles (${mcpTools.map((t) => t.name).join(', ')}) expose their ENTIRE remote toolsets workspace-wide — remote tools can send mail, post messages, etc., with the same trust as send_email.`,
      suggestion: `Deactivate MCP handles you are not using, or scope them to specific agents via tool_ids rather than leaving them on for every chat.`,
    })
  }

  for (const t of s.staleMcpTokens) {
    findings.push({
      key: `stale_mcp_token:${t.name}`,
      severity: 'low',
      title: `MCP/API token "${t.name}" unused for ${t.days} days`,
      detail: `Personal bearer tokens grant full act-as-you access to MCP, the REST APIs, and run-tool. A token nobody uses is pure standing risk.`,
      suggestion: `Revoke it in Settings → Connect Claude; mint a fresh one if it is ever needed again.`,
    })
  }

  if (s.publicArtifacts > 0) {
    findings.push({
      key: 'public_artifacts',
      severity: 'info',
      title: `${s.publicArtifacts} artifact${s.publicArtifacts === 1 ? ' is' : 's are'} public (${s.unlistedArtifacts} unlisted)`,
      detail: `Public/unlisted artifacts are readable by anyone with the link, including via the chrome-free p/<slug> page. That is usually intentional — this is an inventory reminder, not an alarm.`,
      suggestion: `Skim the Artifacts page filtered to non-private and confirm nothing sensitive drifted public.`,
    })
  }

  if (s.adminCount === 1) {
    findings.push({
      key: 'single_admin',
      severity: 'info',
      title: 'The workspace has a single admin',
      detail: `Every governance surface (guardrails, vault, tools, this dashboard) has exactly one person who can act. If that account is lost, so is administrative control.`,
      suggestion: `Promote a second trusted member to admin as a recovery path.`,
    })
  }

  findings.sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity))
  return findings
}

export async function gatherPosture(db: DB): Promise<PostureSnapshot> {
  const [webhooks, guardrails, tools, integrations, vault, artifacts, tokens, admins] = await Promise.all([
    db.from('webhooks').select('id, name, is_active, secret, allow_tools, agent_id, tool_id'),
    db.from('guardrails').select('name, applies_to_webhooks, applies_to_chat, action').eq('is_active', true),
    db.from('tools').select('name, kind').eq('is_active', true),
    db.from('integrations').select('kind, allowed_recipients').eq('kind', 'email').maybeSingle(),
    db.from('vault_secrets').select('name, scope'),
    db.from('artifacts').select('visibility').neq('visibility', 'private'),
    db.from('mcp_tokens').select('name, created_at, last_used_at'),
    db.from('profiles').select('id').eq('is_admin', true),
  ])

  const STALE_DAYS = 90
  const now = Date.now()
  const staleMcpTokens = ((tokens.data ?? []) as Array<{ name: string; created_at: string; last_used_at: string | null }>)
    .map((t) => {
      const last = Date.parse(t.last_used_at ?? t.created_at)
      return { name: t.name, days: Math.floor((now - last) / 86_400_000) }
    })
    .filter((t) => t.days >= STALE_DAYS)

  const nonPrivate = (artifacts.data ?? []) as Array<{ visibility: string }>

  return {
    webhooks: ((webhooks.data ?? []) as Array<Record<string, unknown>>).map((w) => ({
      id: String(w.id),
      name: String(w.name),
      is_active: Boolean(w.is_active),
      has_secret: Boolean(w.secret),
      allow_tools: Boolean(w.allow_tools),
      agent_id: (w.agent_id as string | null) ?? null,
      tool_id: (w.tool_id as string | null) ?? null,
    })),
    guardrails: (guardrails.data ?? []) as PostureSnapshot['guardrails'],
    activeTools: (tools.data ?? []) as PostureSnapshot['activeTools'],
    emailAllowlisted: integrations.data
      ? Array.isArray(integrations.data.allowed_recipients) && integrations.data.allowed_recipients.length > 0
      : null,
    vaultSecrets: (vault.data ?? []) as PostureSnapshot['vaultSecrets'],
    publicArtifacts: nonPrivate.filter((a) => a.visibility === 'public').length,
    unlistedArtifacts: nonPrivate.filter((a) => a.visibility === 'unlisted').length,
    staleMcpTokens,
    adminCount: (admins.data ?? []).length,
  }
}

export function deterministicSummary(findings: Finding[]): string {
  if (findings.length === 0) return 'No findings — the workspace posture checks all passed.'
  const bySev = new Map<Severity, number>()
  for (const f of findings) bySev.set(f.severity, (bySev.get(f.severity) ?? 0) + 1)
  const parts = SEVERITY_ORDER.filter((sv) => bySev.has(sv)).map((sv) => `${bySev.get(sv)} ${sv}`)
  return `${findings.length} finding${findings.length === 1 ? '' : 's'}: ${parts.join(', ')}.`
}
