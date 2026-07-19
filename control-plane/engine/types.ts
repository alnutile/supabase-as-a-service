// Shared types for the provisioning engine. The engine must stay importable from
// both Node (tenant-zero CLI, future `npx create-supanet`) and the control plane's
// edge functions — no Node-only imports in step logic beyond what env.ts isolates.

export interface TenantSpec {
  /** Subdomain + workspace identity, e.g. "acme" → acme.supanet.io */
  slug: string
  /** Human workspace name shown in the app */
  name: string
  /** The buyer's email — receives the "ready" email; first sign-in becomes admin */
  adminEmail: string
}

/** Everything the steps accumulate. Persisted after every step so a re-run resumes. */
export interface TenantState {
  projectRef?: string
  dbPassword?: string
  anonKey?: string
  serviceRoleKey?: string
  openrouterKeyHash?: string
  railwayServiceId?: string
  railwayDomain?: string
  appUrl?: string
  [key: string]: unknown
}

export interface StepContext {
  spec: TenantSpec
  state: TenantState
  log: (message: string) => void
}

export interface Step {
  name: string
  /** Runs the step. Returned object is merged into state. Throw to fail the run. */
  run: (ctx: StepContext) => Promise<Partial<TenantState> | void>
}

export interface StepRecord {
  name: string
  status: 'ok' | 'error'
  finishedAt: string
  error?: string
}

export interface RunResult {
  ok: boolean
  state: TenantState
  steps: StepRecord[]
  /** Name of the step that failed, when ok=false */
  failedStep?: string
}
