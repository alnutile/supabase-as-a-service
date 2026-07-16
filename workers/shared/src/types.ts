import type { SupabaseClient } from '@supabase/supabase-js'
import type { OutputRef } from './contract.js'
import type { ResolvedInput } from './storage.js'

export interface AgentJob {
  id: string
  workspace_id: string | null
  conversation_id: string | null
  requested_by: string | null
  capability: string
  operation: string
  status: string
  priority: number
  instructions: string | null
  input_manifest: unknown
  parameters: Record<string, unknown> | null
  attempts: number
  max_attempts: number
  worker_id: string | null
}

// What an operation handler receives. Inputs are already downloaded to tmpDir and
// verified to belong to `ownerId`; outputs are uploaded via the helpers.
export interface JobContext {
  db: SupabaseClient
  job: AgentJob
  ownerId: string
  instructions: string
  parameters: Record<string, unknown>
  inputs: ResolvedInput[]
  tmpDir: string
  log: (message: string, extra?: Record<string, unknown>) => void
}

export type OperationHandler = (ctx: JobContext) => Promise<OutputRef[]>

export interface WorkerConfig {
  capability: string
  version: string
  handlers: Record<string, OperationHandler>
}
