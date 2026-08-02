// Pure helpers for the Skills-page usage logging area. Kept out of the component
// (per the repo's "extract testable logic" convention) so the count/last-used
// formatting and the "is this skill stale enough to prune" decision are unit-
// tested. Data comes from the `skill_usage_stats()` RPC.

export interface SkillUsageStat {
  skill_id: string
  run_count: number
  last_used_at: string | null
}

export type UsageMap = Record<string, SkillUsageStat>

/** Number of days a skill is considered fresh; past this it's a prune candidate. */
export const DEFAULT_STALE_DAYS = 30

/** Index the skill_usage_stats() rows by skill id for O(1) per-card lookup. */
export function indexUsage(rows: SkillUsageStat[] | null | undefined): UsageMap {
  const map: UsageMap = {}
  for (const r of rows ?? []) map[r.skill_id] = r
  return map
}

/** Whole days since a skill was last used, or null if it has never been used. */
export function daysSinceUsed(
  stat: SkillUsageStat | undefined,
  now: Date = new Date(),
): number | null {
  if (!stat || !stat.last_used_at) return null
  const then = new Date(stat.last_used_at).getTime()
  if (Number.isNaN(then)) return null
  return Math.floor((now.getTime() - then) / 86_400_000)
}

/**
 * A skill is a prune candidate when it has never been used, or hasn't been used
 * within `staleDays`. This is the same signal a future cleanup job keys off of,
 * so the UI badge and the pruner agree on "unused".
 */
export function isStale(
  stat: SkillUsageStat | undefined,
  staleDays: number = DEFAULT_STALE_DAYS,
  now: Date = new Date(),
): boolean {
  const d = daysSinceUsed(stat, now)
  return d === null || d >= staleDays
}

/** Short footer label: "Never used" or "Used 12×". */
export function usageLabel(stat: SkillUsageStat | undefined): string {
  const n = stat?.run_count ?? 0
  return n === 0 ? 'Never used' : `Used ${n}×`
}

/** Count how many of the given skills are stale (prune candidates). */
export function staleCount(
  skillIds: string[],
  usage: UsageMap,
  staleDays: number = DEFAULT_STALE_DAYS,
  now: Date = new Date(),
): number {
  let n = 0
  for (const id of skillIds) if (isStale(usage[id], staleDays, now)) n++
  return n
}
