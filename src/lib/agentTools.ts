// Pure helpers for the agent editor's "Select all / Clear all" tools control
// (used on both agent create and edit). Kept out of the component so the
// selection logic is unit-testable — see agentTools.test.ts.

/** Are all available tools currently selected? (False when there are none.) */
export function allToolsSelected(toolIds: readonly string[], selected: readonly string[]): boolean {
  if (toolIds.length === 0) return false
  const set = new Set(selected)
  return toolIds.every((id) => set.has(id))
}

/**
 * Toggle the whole tool set: if every tool is already selected, clear the
 * selection; otherwise select all available tools. Returns the next id array.
 */
export function toggleAllTools(toolIds: readonly string[], selected: readonly string[]): string[] {
  return allToolsSelected(toolIds, selected) ? [] : [...toolIds]
}
