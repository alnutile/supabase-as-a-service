// RunRecorder — persists an observability trace of one agent invocation into
// `agent_runs` (header) + `agent_run_steps` (rows), so the /agents/:id page can
// show what an agent actually did: each model turn, each tool call with its raw
// input/output, tokens, cost, duration, and the final outcome.
//
// Wired into all four agent loops (chat, scheduler, webhook, slack) at the seam
// they already share: model turn → tool calls → results. Best-effort like
// recordUsage/logActivity — a failure here NEVER breaks a run. Written with the
// service role (the loops run as service role), so RLS governs reads only.
//
// A recorder only exists when there's an agent to attribute the run to
// (`open` returns null otherwise), so plain user chat creates no rows — the page
// is about deployed agents, and a run with no agent has nowhere to live.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4'
import type { ORUsage } from './openrouter.ts'
import { clip } from './run_recorder_pure.ts'

type DB = ReturnType<typeof createClient>

export type RunSurface = 'chat' | 'schedule' | 'webhook' | 'slack' | 'listener' | 'manual'

export { clip }

function tokensOf(u: ORUsage | undefined): number {
  return u?.totalTokens ?? 0
}

export class RunRecorder {
  private seq = 0
  private turns = 0
  private toolCalls = 0
  private tokens = 0
  private cost = 0

  private constructor(
    private db: DB,
    private runId: string,
  ) {}

  // Insert the run header (status 'running') and return a recorder — or null when
  // there's no agent/owner/db to attribute it to, or the insert fails. Callers use
  // `await rec?.xxx(...)` so a null recorder is a no-op everywhere.
  static async open(
    db: DB | null,
    args: {
      agentId?: string | null
      ownerId: string | null
      surface: RunSurface
      triggerRef?: Record<string, unknown>
      model?: string | null
      input?: string | null
    },
  ): Promise<RunRecorder | null> {
    if (!db || !args.agentId || !args.ownerId) return null
    try {
      const { data, error } = await db
        .from('agent_runs')
        .insert({
          agent_id: args.agentId,
          owner_id: args.ownerId,
          surface: args.surface,
          trigger_ref: args.triggerRef ?? {},
          status: 'running',
          model: args.model ?? null,
          input: args.input != null ? clip(args.input, 8000) : null,
        })
        .select('id')
        .single()
      if (error || !data) return null
      return new RunRecorder(db, data.id as string)
    } catch {
      return null
    }
  }

  // Record one model round-trip (its assistant text + token/cost usage).
  async modelTurn(content: string, usage: ORUsage | undefined): Promise<void> {
    this.turns++
    const t = tokensOf(usage)
    const c = usage?.cost ?? 0
    this.tokens += t
    this.cost += c
    await this.insertStep({ kind: 'model', output: clip(content), tokens: t, cost: c })
  }

  // Record one tool call with its arguments and result (or error).
  async toolStep(args: {
    name: string
    input?: Record<string, unknown> | null
    output?: string
    error?: string | null
    sandboxed?: boolean
    durationMs?: number
  }): Promise<void> {
    this.toolCalls++
    await this.insertStep({
      kind: 'tool',
      tool_name: args.name,
      input: args.input ?? null,
      output: args.output != null ? clip(args.output) : null,
      error: args.error ?? null,
      sandboxed: args.sandboxed ?? false,
      duration_ms: args.durationMs ?? null,
    })
  }

  // Finalize the header: status, final output, rolled-up totals, ended_at.
  async finish(args: { status: 'done' | 'error'; finalOutput?: string | null; error?: string | null }): Promise<void> {
    try {
      await this.db
        .from('agent_runs')
        .update({
          status: args.status,
          final_output: args.finalOutput != null ? clip(args.finalOutput, 8000) : null,
          error: args.error ?? null,
          turns: this.turns,
          tool_calls: this.toolCalls,
          total_tokens: this.tokens,
          cost: this.cost,
          ended_at: new Date().toISOString(),
        })
        .eq('id', this.runId)
    } catch {
      // best-effort — never block a run on its own accounting
    }
  }

  // deno-lint-ignore no-explicit-any
  private async insertStep(row: Record<string, any>): Promise<void> {
    try {
      await this.db.from('agent_run_steps').insert({ run_id: this.runId, seq: this.seq++, ...row })
    } catch {
      // best-effort
    }
  }
}
