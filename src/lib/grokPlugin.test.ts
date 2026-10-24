import { describe, expect, it } from 'vitest'

// Structural guard for the Grok Build plugin in `grok-plugin/` (see
// docs/grok-plugin.md). The marketplace's CI validates the CATALOG entry, not the
// plugin itself, and a broken plugin only shows up when a user installs it - so
// the checks that matter (valid JSON, frontmatter on every component, no
// hardcoded tenant URL) have to live here.
//
// import.meta.glob with ?raw reads the files at build time, the same mechanism
// functionSources.ts and migrations.test.ts use - no filesystem access needed.
const raw = (pattern: Record<string, string>) => pattern

const manifests = raw(
  import.meta.glob('../../grok-plugin/.grok-plugin/plugin.json', {
    query: '?raw',
    import: 'default',
    eager: true,
  }) as Record<string, string>,
)

const mcpConfigs = raw(
  import.meta.glob('../../grok-plugin/.mcp.json', {
    query: '?raw',
    import: 'default',
    eager: true,
  }) as Record<string, string>,
)

const skills = raw(
  import.meta.glob('../../grok-plugin/skills/*/SKILL.md', {
    query: '?raw',
    import: 'default',
    eager: true,
  }) as Record<string, string>,
)

const commands = raw(
  import.meta.glob('../../grok-plugin/commands/*.md', {
    query: '?raw',
    import: 'default',
    eager: true,
  }) as Record<string, string>,
)

function frontmatter(source: string): Record<string, string> | null {
  const m = source.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!m) return null
  const out: Record<string, string> = {}
  let key: string | null = null
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z][\w-]*):\s*(.*)$/)
    if (kv) {
      key = kv[1]
      // `>-` / `|` block scalars carry their value on the following lines.
      out[key] = kv[2].replace(/^[>|][-+]?$/, '').trim()
    } else if (key && line.trim()) {
      out[key] = `${out[key]} ${line.trim()}`.trim()
    }
  }
  return out
}

function nameOf(path: string): string {
  return path.split('/').slice(-2).join('/')
}

describe('grok plugin manifest', () => {
  it('exists and is valid JSON', () => {
    expect(Object.keys(manifests)).toHaveLength(1)
  })

  it('carries the fields the marketplace entry is generated from', () => {
    const manifest = JSON.parse(Object.values(manifests)[0])
    for (const field of ['name', 'version', 'description', 'homepage', 'license', 'keywords']) {
      expect(manifest[field], `plugin.json is missing "${field}"`).toBeTruthy()
    }
    // kebab-case is a catalog requirement - the entry's `name` is taken from here.
    expect(manifest.name).toMatch(/^[a-z][a-z0-9-]*$/)
    expect(Array.isArray(manifest.keywords)).toBe(true)
    // Generic keywords mis-fire Grok's plugin CTA on unrelated requests, so the
    // marketplace pushes back on them. Every keyword must be brand-scoped.
    for (const keyword of manifest.keywords as string[]) {
      expect(keyword.toLowerCase(), `keyword "${keyword}" is not brand-scoped`).toMatch(
        /supanet|intranet in a box/,
      )
    }
  })
})

describe('grok plugin mcp config', () => {
  it('declares exactly one http server named supanet', () => {
    const config = JSON.parse(Object.values(mcpConfigs)[0])
    const names = Object.keys(config.mcpServers ?? {})
    expect(names).toEqual(['supanet'])
    expect(config.mcpServers.supanet.type).toBe('http')
  })

  it('reads the workspace URL from the environment, never a hardcoded tenant', () => {
    const config = JSON.parse(Object.values(mcpConfigs)[0])
    const url: string = config.mcpServers.supanet.url
    // Every workspace is its own deployment. A literal URL here would point one
    // user's OAuth approval at another user's workspace.
    expect(url).toContain('${SUPANET_MCP_URL')
    expect(url).not.toMatch(/https?:\/\//)
  })

  it('ships no command-based server (nothing executes locally)', () => {
    const config = JSON.parse(Object.values(mcpConfigs)[0])
    for (const server of Object.values(config.mcpServers) as Record<string, unknown>[]) {
      expect(server.command, 'a command server would fail marketplace review').toBeUndefined()
    }
  })
})

describe('grok plugin components', () => {
  it('ships skills and commands', () => {
    expect(Object.keys(skills).length).toBeGreaterThan(0)
    expect(Object.keys(commands).length).toBeGreaterThan(0)
  })

  it('gives every skill a name matching its directory, and a description', () => {
    for (const [path, source] of Object.entries(skills)) {
      const fm = frontmatter(source)
      expect(fm, `${nameOf(path)} has no YAML frontmatter`).not.toBeNull()
      const dir = path.split('/').slice(-2)[0]
      expect(fm!.name, `${nameOf(path)} name must equal its directory`).toBe(dir)
      // The description is the whole trigger mechanism - a thin one never loads.
      expect(fm!.description?.length ?? 0).toBeGreaterThan(80)
    }
  })

  it('gives every command a description', () => {
    for (const [path, source] of Object.entries(commands)) {
      const fm = frontmatter(source)
      expect(fm, `${nameOf(path)} has no YAML frontmatter`).not.toBeNull()
      expect(fm!.description?.length ?? 0).toBeGreaterThan(20)
    }
  })
})
