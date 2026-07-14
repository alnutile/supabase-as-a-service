import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import type { Database } from '../../lib/database.types'
import { mcpUrl, supabase } from '../../lib/supabase'
import { useAuth } from '../../contexts/AuthContext'
import { formatDate } from '../../lib/util'
import { CopyIcon, PlusIcon, TrashIcon } from '../../components/icons'

type McpToken = Database['public']['Tables']['mcp_tokens']['Row']

// The one-click OAuth connector is served from the APP's own domain (see server.js),
// not the Supabase functions host — that's the only place OAuth discovery resolves.
const connectorUrl = `${window.location.origin}/mcp`

export function ConnectClaude() {
  const { user } = useAuth()
  const hasPassword = Boolean(user?.user_metadata?.has_password)
  const [tokens, setTokens] = useState<McpToken[]>([])
  const [copied, setCopied] = useState<string | null>(null)

  const load = useCallback(async () => {
    const { data } = await supabase
      .from('mcp_tokens')
      .select('*')
      .order('created_at', { ascending: false })
    setTokens(data ?? [])
  }, [])

  useEffect(() => {
    load()
  }, [load])

  async function generate() {
    await supabase.from('mcp_tokens').insert({ owner_id: user!.id, name: 'Claude' })
    load()
  }

  async function revoke(id: string) {
    await supabase.from('mcp_tokens').delete().eq('id', id)
    load()
  }

  async function copy(text: string, key: string) {
    await navigator.clipboard.writeText(text)
    setCopied(key)
    setTimeout(() => setCopied(null), 1500)
  }

  return (
    <section className="mt-6 rounded-xl border border-border bg-surface p-5">
      <h2 className="text-sm font-semibold text-text">Connect Claude (MCP)</h2>
      <p className="mt-1 text-sm text-muted">
        Connect Claude to this workspace, then say "build an agent that does X on my intranet" and
        Claude pushes it here — it shows up under Agents, Tools, and Webhooks. There are two ways to
        connect; the first is the easiest.
      </p>

      {/* Option 1 — OAuth custom connector (recommended). Signs in at the app domain. */}
      <div className="mt-4 rounded-xl border border-primary/40 bg-primary/5 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-full bg-primary/15 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-primary">
            Recommended
          </span>
          <h3 className="text-sm font-semibold text-text">Add custom connector (sign in — no token)</h3>
        </div>
        <p className="mt-2 text-sm text-muted">
          Works in <strong>Claude Desktop</strong> and <strong>claude.ai</strong>. In Claude, open{' '}
          <strong>Settings → Connectors → Add custom connector</strong>, paste the URL below, leave the
          OAuth Client ID / Secret fields <strong>empty</strong>, and click <strong>Add</strong>. Claude
          sends you to a sign-in page — log in with your workspace <strong>email + password</strong> and
          approve.
        </p>

        {!hasPassword && (
          <div className="mt-3 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-300">
            <strong>One-time setup:</strong> the connector signs in with a <strong>password</strong>, but
            your account uses magic links and doesn't have one yet.{' '}
            <Link to="/settings/profile" className="font-semibold underline">
              Set a password
            </Link>{' '}
            first, then come back here.
          </div>
        )}

        <div className="mt-3 flex items-center gap-2">
          <code className="min-w-0 flex-1 truncate rounded-lg bg-surface-2 px-3 py-2 text-xs text-text">
            {connectorUrl}
          </code>
          <button
            onClick={() => copy(connectorUrl, 'connector')}
            className="flex shrink-0 items-center gap-1 rounded-lg border border-border-strong px-2.5 py-2 text-xs font-medium text-muted hover:bg-surface-hover"
          >
            <CopyIcon className="h-3.5 w-3.5" /> {copied === 'connector' ? 'Copied' : 'Copy'}
          </button>
        </div>
        <p className="mt-2 text-[11px] leading-relaxed text-faint">
          This is your app's own URL — OAuth discovery is served here (a raw{' '}
          <code className="rounded bg-surface-2 px-1">*.supabase.co</code> URL can't do the discovery step).
        </p>
      </div>

      {/* Option 2 — personal bearer token (Claude Code CLI, or a fallback). */}
      <div className="mt-6 border-t border-border pt-5">
        <h3 className="text-sm font-semibold text-text">Or use a personal token</h3>
        <p className="mt-1 text-sm text-muted">
          Best for <strong>Claude Code</strong> (the CLI), or as a fallback. Generate a token and follow
          the steps for your client.
        </p>
      </div>

      <div className="mt-3 flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded-lg bg-surface-2 px-3 py-2 text-xs text-text">
          {mcpUrl}
        </code>
        <button
          onClick={() => copy(mcpUrl, 'url')}
          className="flex shrink-0 items-center gap-1 rounded-lg border border-border-strong px-2.5 py-2 text-xs font-medium text-muted hover:bg-surface-hover"
        >
          <CopyIcon className="h-3.5 w-3.5" /> {copied === 'url' ? 'Copied' : 'Copy'}
        </button>
      </div>

      <div className="mt-4">
        <button
          onClick={generate}
          className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-sm font-semibold text-white hover:bg-primary-strong"
        >
          <PlusIcon className="h-4 w-4" /> New connection token
        </button>
      </div>

      <div className="mt-3 space-y-3">
        {tokens.map((t) => {
          const cmd = `claude mcp add --scope user --transport http intranet ${mcpUrl} --header "Authorization: Bearer ${t.token}"`
          const desktopConfigLines = [
            '"intranet": {',
            '  "command": "npx",',
            '  "args": [',
            '    "-y",',
            '    "mcp-remote",',
            `    "${mcpUrl}",`,
            '    "--header",',
            '    "Authorization:${AUTH_HEADER}"',
            '  ],',
            '  "env": {',
            `    "AUTH_HEADER": "Bearer ${t.token}"`,
            '  }',
            '}'
          ]
          const desktopConfig = desktopConfigLines.join('\n')

          return (
            <div key={t.id} className="rounded-lg border border-border p-3">
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium text-muted">
                  {t.name} · {t.last_used_at ? `last used ${formatDate(t.last_used_at)}` : 'never used'}
                </span>
                <button
                  onClick={() => revoke(t.id)}
                  className="ml-auto rounded-md p-1 text-faint hover:bg-red-50 hover:text-red-600"
                  title="Revoke"
                >
                  <TrashIcon className="h-4 w-4" />
                </button>
              </div>

              <div className="mt-3 space-y-3">
                <div>
                  <p className="text-xs font-semibold text-text">For Claude Code (CLI)</p>
                  <p className="mt-1 text-xs text-muted">
                    Run this in your terminal (anywhere — <code className="rounded bg-surface-2 px-1">--scope user</code>{' '}
                    makes it available in every project):
                  </p>
                  <div className="mt-1 flex items-start gap-2">
                    <pre className="min-w-0 flex-1 overflow-x-auto rounded-lg bg-slate-900 p-2 text-[11px] leading-relaxed text-slate-100">
                      {cmd}
                    </pre>
                    <button
                      onClick={() => copy(cmd, `code-${t.id}`)}
                      className="shrink-0 rounded-lg border border-border-strong px-2 py-1.5 text-xs font-medium text-muted hover:bg-surface-hover"
                    >
                      {copied === `code-${t.id}` ? 'Copied' : 'Copy'}
                    </button>
                  </div>
                  <p className="mt-1 text-xs text-muted">
                    Start <code className="rounded bg-surface-2 px-1">claude</code> and run{' '}
                    <code className="rounded bg-surface-2 px-1">/mcp</code> — you should see{' '}
                    <strong>intranet</strong> connected.
                  </p>
                </div>

                <div>
                  <p className="text-xs font-semibold text-text">For Claude Desktop</p>
                  <p className="mt-1 text-xs text-muted">
                    Open <strong>Settings → Developer → Edit Config</strong> and add this to the{' '}
                    <code className="rounded bg-surface-2 px-1">mcpServers</code> section:
                  </p>
                  <div className="mt-1 flex items-start gap-2">
                    <pre className="min-w-0 flex-1 overflow-x-auto rounded-lg bg-slate-900 p-2 text-[11px] leading-relaxed text-slate-100">
                      {desktopConfig}
                    </pre>
                    <button
                      onClick={() => copy(desktopConfig, `desktop-${t.id}`)}
                      className="shrink-0 rounded-lg border border-border-strong px-2 py-1.5 text-xs font-medium text-muted hover:bg-surface-hover"
                    >
                      {copied === `desktop-${t.id}` ? 'Copied' : 'Copy'}
                    </button>
                  </div>
                  <p className="mt-1 text-xs text-muted">
                    Restart Claude Desktop, then check the MCP icon (🔌) — you should see{' '}
                    <strong>intranet</strong> connected.
                  </p>
                </div>
              </div>

              <p className="mt-3 text-[11px] text-faint">
                Treat this token like a password — anyone with it can act as you here. Revoke it (🗑) if it leaks.
              </p>
            </div>
          )
        })}
        {tokens.length === 0 && (
          <p className="text-xs text-faint">No connection tokens yet.</p>
        )}
      </div>
    </section>
  )
}
