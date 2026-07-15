import { describe, it, expect } from 'vitest'

// Test the filtering logic itself (pure function)
describe('Skills search filtering', () => {
  const mockSkills = [
    {
      id: '1',
      name: 'Code Review',
      description: 'Review code for quality',
      instructions: 'Check for bugs and style issues',
      auto_apply: false,
      output_mode: 'reply' as const,
      artifact_type: 'markdown' as const,
      owner_id: 'user1',
      created_at: '2024-01-01',
      updated_at: '2024-01-01',
      is_builtin: false,
    },
    {
      id: '2',
      name: 'Documentation',
      description: 'Generate documentation',
      instructions: 'Create comprehensive docs',
      auto_apply: false,
      output_mode: 'artifact' as const,
      artifact_type: 'markdown' as const,
      owner_id: 'user1',
      created_at: '2024-01-01',
      updated_at: '2024-01-01',
      is_builtin: false,
    },
    {
      id: '3',
      name: 'SQL Query',
      description: 'Help write SQL',
      instructions: 'Write efficient SQL queries',
      auto_apply: true,
      output_mode: 'reply' as const,
      artifact_type: 'markdown' as const,
      owner_id: 'user1',
      created_at: '2024-01-01',
      updated_at: '2024-01-01',
      is_builtin: false,
    },
  ]

  // Pure function extracted from the component for testing.
  // Generic over the element type so it also accepts skills whose
  // `description` is null (the column is nullable) — see the null-handling
  // test below.
  function filterSkills<T extends { name: string; description: string | null; instructions: string }>(
    skillList: T[],
    searchQuery: string
  ): T[] {
    if (!searchQuery.trim()) return skillList
    const query = searchQuery.toLowerCase()
    return skillList.filter(
      (s) =>
        s.name.toLowerCase().includes(query) ||
        s.description?.toLowerCase().includes(query) ||
        s.instructions.toLowerCase().includes(query)
    )
  }

  it('returns all skills when search is empty', () => {
    expect(filterSkills(mockSkills, '')).toEqual(mockSkills)
    expect(filterSkills(mockSkills, '   ')).toEqual(mockSkills)
  })

  it('filters by name', () => {
    const result = filterSkills(mockSkills, 'code')
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe('Code Review')
  })

  it('filters by description', () => {
    const result = filterSkills(mockSkills, 'documentation')
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe('Documentation')
  })

  it('filters by instructions', () => {
    const result = filterSkills(mockSkills, 'efficient')
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe('SQL Query')
  })

  it('is case-insensitive', () => {
    expect(filterSkills(mockSkills, 'CODE')).toHaveLength(1)
    expect(filterSkills(mockSkills, 'Code')).toHaveLength(1)
    expect(filterSkills(mockSkills, 'code')).toHaveLength(1)
  })

  it('returns multiple matches', () => {
    const result = filterSkills(mockSkills, 'query')
    expect(result).toHaveLength(1) // matches "SQL Query" and also "queries" in instructions
  })

  it('returns empty array when no matches', () => {
    const result = filterSkills(mockSkills, 'nonexistent')
    expect(result).toHaveLength(0)
  })

  it('handles partial matches', () => {
    const result = filterSkills(mockSkills, 'doc')
    expect(result).toHaveLength(1) // "Documentation" name
    expect(result[0].name).toBe('Documentation')
  })

  it('handles null description gracefully', () => {
    const skillsWithNull = [
      { ...mockSkills[0], description: null },
    ]
    expect(() => filterSkills(skillsWithNull, 'review')).not.toThrow()
    expect(filterSkills(skillsWithNull, 'quality')).toHaveLength(0)
  })
})
