// Pure helpers for RunRecorder — no imports, so they're trivially unit-tested
// (tests/run_recorder_test.ts) without resolving the supabase npm module.

// Keep stored text bounded — a tool result can be 50k chars; the timeline shows a
// preview, not the whole payload.
export function clip(s: unknown, max = 4000): string {
  const str = typeof s === 'string' ? s : String(s ?? '')
  return str.length > max ? str.slice(0, max) + `\n… (${str.length - max} more chars)` : str
}
