// Orchestration for the `run_security_scan` builtin: scan-row lifecycle,
// status carry-over across runs, and the one best-effort utility-model summary
// call. Kept SEPARATE from security.ts on purpose: this module (statically)
// imports models/openrouter/usage, whose graph includes npm: packages and
// Deno.env reads — security.ts stays import-free so the evaluator tests
// (tests/security_test.ts) type-check and run with no node_modules and no env
// access. Only builtins.ts imports this file.
import { resolveModel } from './models.ts'
import { orComplete, systemMsg } from './openrouter.ts'
import { recordUsage } from './usage.ts'
import {
  deterministicSummary,
  evaluatePosture,
  gatherPosture,
  SCAN_STEPS,
  scanProgress,
  type Finding,
} from './security.ts'

// deno-lint-ignore no-explicit-any
type DB = any

// One best-effort utility-model call for a readable run summary. The findings
// themselves are already decided — this only writes prose, so any failure
// falls back to the computed summary.
async function modelSummary(db: DB, findings: Finding[], actorId: string | null): Promise<string> {
  const fallback = deterministicSummary(findings)
  if (findings.length === 0) return fallback
  try {
    const model = await resolveModel(db, 'utility')
    const out = await orComplete({
      model,
      maxTokens: 300,
      messages: [
        systemMsg(
          'You summarize automated security scan results for a small team dashboard. Reply with 2-3 plain sentences: overall posture, the most important item to fix first, and why. No markdown, no lists, no preamble.',
        ),
        {
          role: 'user',
          content: `Scan results (JSON):\n${JSON.stringify(
            findings.map((f) => ({ severity: f.severity, title: f.title })),
          )}`,
        },
      ],
    })
    await recordUsage(db, { context: 'security', model, actorId, usage: out.usage })
    const text = (out.content ?? '').trim()
    return text ? `${fallback} ${text}` : fallback
  } catch {
    return fallback
  }
}

export async function runSecurityScan(db: DB | null, userId: string | null): Promise<string> {
  if (!db) return 'The security scan is unavailable.'
  // Admin gate IN CODE: run-tool and the agent loops execute builtins with the
  // service role, so the dashboard's RLS alone doesn't protect this path.
  const { data: profile } = await db.from('profiles').select('is_admin').eq('id', userId).maybeSingle()
  if (!profile?.is_admin) return 'The security scan is admin-only.'

  const { data: scan, error: scanErr } = await db
    .from('security_scans')
    .insert({ triggered_by: userId, progress: scanProgress(0) })
    .select('id')
    .single()
  if (scanErr || !scan) return `Could not start a scan: ${scanErr?.message ?? 'insert failed'}`

  // Best-effort step reporting: the dashboard follows the row over Realtime,
  // but a failed progress write must never fail the scan itself.
  const setStep = async (current: number) => {
    try {
      await db.from('security_scans').update({ progress: scanProgress(current) }).eq('id', scan.id)
    } catch {
      // ignore — progress is cosmetic
    }
  }

  try {
    const snapshot = await gatherPosture(db)
    await setStep(1)
    const findings = evaluatePosture(snapshot)
    await setStep(2)

    // Carry dismissed/promoted status forward: same key + a prior non-open
    // status means the team already triaged this exact item.
    const keys = findings.map((f) => f.key)
    const prior = new Map<string, { status: string; feature_id: string | null }>()
    if (keys.length > 0) {
      const { data: priorRows } = await db
        .from('security_findings')
        .select('key, status, feature_id, created_at')
        .in('key', keys)
        .neq('status', 'open')
        .order('created_at', { ascending: false })
      for (const row of (priorRows ?? []) as Array<{ key: string; status: string; feature_id: string | null }>) {
        if (!prior.has(row.key)) prior.set(row.key, { status: row.status, feature_id: row.feature_id })
      }
    }

    if (findings.length > 0) {
      const { error: insErr } = await db.from('security_findings').insert(
        findings.map((f) => ({
          scan_id: scan.id,
          key: f.key,
          severity: f.severity,
          title: f.title,
          detail: f.detail,
          suggestion: f.suggestion,
          status: prior.get(f.key)?.status ?? 'open',
          feature_id: prior.get(f.key)?.feature_id ?? null,
        })),
      )
      if (insErr) throw new Error(`Could not save findings: ${insErr.message}`)
    }

    await setStep(3)
    const summary = await modelSummary(db, findings, userId)
    await db
      .from('security_scans')
      .update({
        status: 'ok',
        summary,
        findings_count: findings.length,
        progress: scanProgress(SCAN_STEPS.length),
        finished_at: new Date().toISOString(),
      })
      .eq('id', scan.id)
    await db.from('activity_log').insert({
      type: 'security.scan',
      summary: `Security scan: ${deterministicSummary(findings)}`,
      detail: { scan_id: scan.id, findings: findings.length },
      actor_id: userId,
    })

    const open = findings.filter((f) => (prior.get(f.key)?.status ?? 'open') === 'open')
    const lines = open
      .slice(0, 10)
      .map((f) => `- [${f.severity}] ${f.title}`)
      .join('\n')
    return `${summary}\n\n${open.length} open finding${open.length === 1 ? '' : 's'} (previously triaged items keep their status). Review them on the Security dashboard (Governance → Security).${lines ? `\n${lines}` : ''}`
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'scan failed'
    await db
      .from('security_scans')
      .update({ status: 'error', error: msg, finished_at: new Date().toISOString() })
      .eq('id', scan.id)
    return `Security scan failed: ${msg}`
  }
}
