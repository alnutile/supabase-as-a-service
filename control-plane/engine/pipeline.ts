// The resumable step runner — the pure heart of the provisioner. Steps are
// idempotent-by-contract; the runner adds resume-by-skip: a step recorded as 'ok'
// in `completed` never re-runs, so a failed provision re-enters at the failed
// step. `persist` is called after every step (job row in the control plane,
// a state file for tenant-zero) so a crash loses at most one step's progress.

import type { RunResult, Step, StepRecord, TenantSpec, TenantState } from './types.ts'

export interface RunOptions {
  spec: TenantSpec
  steps: Step[]
  /** Step names already completed in a prior run (resume). */
  completed?: string[]
  /** State accumulated by the prior run. */
  initialState?: TenantState
  persist?: (snapshot: { state: TenantState; steps: StepRecord[] }) => Promise<void> | void
  log?: (message: string) => void
}

// Keys starting with `_` are in-memory transients (never persisted). Steps
// should avoid them entirely for secrets — this strip is defense in depth.
function persistable(state: TenantState): TenantState {
  return Object.fromEntries(Object.entries(state).filter(([k]) => !k.startsWith('_')))
}

export async function runPipeline(opts: RunOptions): Promise<RunResult> {
  const log = opts.log ?? (() => {})
  const completed = new Set(opts.completed ?? [])
  const state: TenantState = { ...(opts.initialState ?? {}) }
  const steps: StepRecord[] = []

  for (const step of opts.steps) {
    if (completed.has(step.name)) {
      log(`↷ ${step.name} (already done, skipping)`)
      continue
    }
    log(`▶ ${step.name}`)
    try {
      const out = await step.run({ spec: opts.spec, state, log })
      if (out) Object.assign(state, out)
      steps.push({ name: step.name, status: 'ok', finishedAt: new Date().toISOString() })
      await opts.persist?.({ state: persistable(state), steps })
      log(`✓ ${step.name}`)
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      steps.push({ name: step.name, status: 'error', finishedAt: new Date().toISOString(), error })
      await opts.persist?.({ state: persistable(state), steps })
      log(`✗ ${step.name}: ${error}`)
      return { ok: false, state, steps, failedStep: step.name }
    }
  }
  return { ok: true, state, steps }
}

/** Poll `check` until it returns true or `timeoutMs` elapses. */
export async function waitFor(
  label: string,
  check: () => Promise<boolean>,
  { timeoutMs = 5 * 60_000, intervalMs = 5_000 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  throw new Error(`timed out waiting for ${label} (${Math.round(timeoutMs / 1000)}s)`)
}
