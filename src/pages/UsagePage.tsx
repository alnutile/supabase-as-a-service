import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'

// Aggregated spend, shape returned by the usage_summary(p_days) RPC.
interface ModelRow { model: string; cost: number; tokens: number; calls: number }
interface ContextRow { context: string; cost: number; tokens: number; calls: number }
interface UserRow { actor_id: string | null; email: string | null; cost: number; tokens: number; calls: number }
interface DailyRow { day: string; cost: number; tokens: number }
interface Summary {
  days: number
  total_cost: number
  total_tokens: number
  total_calls: number
  by_model: ModelRow[]
  by_context: ContextRow[]
  by_user: UserRow[]
  daily: DailyRow[]
}

interface Balance {
  label: string | null
  usage: number | null
  limit: number | null
  limit_remaining: number | null
  is_free_tier: boolean
  error?: string
}

const RANGES = [
  { days: 7, label: '7 days' },
  { days: 30, label: '30 days' },
  { days: 90, label: '90 days' },
] as const

const usd = (n: number | null | undefined) =>
  n == null ? '—' : `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`
const num = (n: number | null | undefined) => (n == null ? '—' : n.toLocaleString())

export default function UsagePage() {
  const [days, setDays] = useState<number>(30)
  const [summary, setSummary] = useState<Summary | null>(null)
  const [balance, setBalance] = useState<Balance | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (d: number) => {
    setLoading(true)
    setError(null)
    const [{ data, error: rpcErr }, fn] = await Promise.all([
      supabase.rpc('usage_summary', { p_days: d }),
      supabase.functions.invoke('openrouter-balance'),
    ])
    if (rpcErr) setError(rpcErr.message)
    else setSummary(data as unknown as Summary)
    setBalance((fn.data as Balance) ?? null)
    setLoading(false)
  }, [])

  useEffect(() => {
    load(days)
  }, [days, load])

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-4xl px-6 py-8">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-slate-900">Usage</h1>
            <p className="mt-1 text-sm text-slate-500">Token spend and OpenRouter balance for the workspace.</p>
          </div>
          <div className="flex shrink-0 rounded-lg border border-slate-200 bg-white p-0.5">
            {RANGES.map((r) => (
              <button
                key={r.days}
                onClick={() => setDays(r.days)}
                className={`rounded-md px-2.5 py-1 text-xs font-medium ${
                  days === r.days ? 'bg-brand-600 text-white' : 'text-slate-600 hover:bg-slate-50'
                }`}
              >
                {r.label}
              </button>
            ))}
          </div>
        </div>

        {error && (
          <div className="mt-6 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
            {error.includes('admin') ? 'Usage is admin-only.' : error}
          </div>
        )}

        {/* Balance */}
        <BalanceCard balance={balance} />

        {/* Totals */}
        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Stat label={`Spend (last ${days}d)`} value={usd(summary?.total_cost)} />
          <Stat label="Tokens" value={num(summary?.total_tokens)} />
          <Stat label="Calls" value={num(summary?.total_calls)} />
        </div>

        {/* Daily chart */}
        <DailyChart daily={summary?.daily ?? []} />

        {/* Breakdowns */}
        <Breakdown
          title="By model"
          rows={(summary?.by_model ?? []).map((r) => ({ key: r.model, label: r.model, cost: r.cost, tokens: r.tokens, calls: r.calls }))}
        />
        <Breakdown
          title="By context"
          rows={(summary?.by_context ?? []).map((r) => ({ key: r.context, label: r.context, cost: r.cost, tokens: r.tokens, calls: r.calls }))}
        />
        <Breakdown
          title="By user"
          rows={(summary?.by_user ?? []).map((r) => ({ key: r.actor_id ?? 'unknown', label: r.email ?? '(unknown)', cost: r.cost, tokens: r.tokens, calls: r.calls }))}
        />

        {loading && <p className="mt-6 text-sm text-slate-400">Loading…</p>}
        {!loading && summary && summary.total_calls === 0 && (
          <p className="mt-6 text-sm text-slate-400">No usage recorded in this window yet.</p>
        )}
      </div>
    </div>
  )
}

function BalanceCard({ balance }: { balance: Balance | null }) {
  if (!balance) return null
  if (balance.error) {
    return (
      <section className="mt-6 rounded-xl border border-slate-200 bg-white p-5">
        <h2 className="text-sm font-semibold text-slate-700">OpenRouter balance</h2>
        <p className="mt-1 text-sm text-slate-500">Couldn't load balance: {balance.error}</p>
      </section>
    )
  }
  const hasLimit = balance.limit != null
  return (
    <section className="mt-6 rounded-xl border border-slate-200 bg-white p-5">
      <h2 className="text-sm font-semibold text-slate-700">OpenRouter balance</h2>
      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Stat label="Remaining" value={hasLimit ? usd(balance.limit_remaining) : 'No per-key limit'} />
        <Stat label="Spent on key" value={usd(balance.usage)} />
        <Stat label="Key limit" value={hasLimit ? usd(balance.limit) : '—'} />
      </div>
      {balance.is_free_tier && (
        <p className="mt-3 text-xs text-amber-600">This key is on the free tier.</p>
      )}
    </section>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="text-xs font-medium text-slate-500">{label}</div>
      <div className="mt-1 text-lg font-semibold text-slate-900">{value}</div>
    </div>
  )
}

// Inline bar chart of daily cost (no chart dependency — matches the project's
// no-extra-deps approach).
function DailyChart({ daily }: { daily: DailyRow[] }) {
  if (!daily.length) return null
  const max = Math.max(...daily.map((d) => d.cost), 0.0000001)
  return (
    <section className="mt-4 rounded-xl border border-slate-200 bg-white p-5">
      <h2 className="text-sm font-semibold text-slate-700">Daily spend</h2>
      <div className="mt-4 flex h-32 items-end gap-1">
        {daily.map((d) => (
          <div key={d.day} className="group relative flex flex-1 flex-col items-center justify-end">
            <div
              className="w-full rounded-t bg-brand-400 transition-all group-hover:bg-brand-600"
              style={{ height: `${Math.max((d.cost / max) * 100, 1)}%` }}
            />
            <div className="pointer-events-none absolute -top-8 hidden whitespace-nowrap rounded bg-slate-800 px-1.5 py-0.5 text-[10px] text-white group-hover:block">
              {d.day.slice(5)}: {usd(d.cost)}
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}

function Breakdown({
  title,
  rows,
}: {
  title: string
  rows: { key: string; label: string; cost: number; tokens: number; calls: number }[]
}) {
  if (!rows.length) return null
  return (
    <section className="mt-4 rounded-xl border border-slate-200 bg-white p-5">
      <h2 className="text-sm font-semibold text-slate-700">{title}</h2>
      <table className="mt-3 w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-slate-400">
            <th className="pb-2 font-medium"></th>
            <th className="pb-2 text-right font-medium">Cost</th>
            <th className="pb-2 text-right font-medium">Tokens</th>
            <th className="pb-2 text-right font-medium">Calls</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key} className="border-t border-slate-100">
              <td className="py-1.5 pr-2 font-mono text-xs text-slate-700">{r.label}</td>
              <td className="py-1.5 text-right tabular-nums text-slate-900">{usd(r.cost)}</td>
              <td className="py-1.5 text-right tabular-nums text-slate-500">{num(r.tokens)}</td>
              <td className="py-1.5 text-right tabular-nums text-slate-500">{num(r.calls)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}
