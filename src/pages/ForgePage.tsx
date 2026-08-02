import { useCallback, useEffect, useState } from 'react'
import type { Database } from '../lib/database.types'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import {
  deleteForgedFunction,
  deployCore,
  deployFunction,
  generateFunction,
  redeployAllForged,
  redeployFunction,
  type DeployResultRow,
  type GeneratedPreview,
} from '../lib/forge'
import { ForgeIcon, PlayIcon, PlusIcon, TrashIcon } from '../components/icons'

type Forged = Database['public']['Tables']['forged_functions']['Row']

// The app's own repo edge functions — the `deploy_core` allow-list (CORE_SLUGS in
// supabase/functions/forge/index.ts). Shown read-only so an admin can see what
// "Update core functions" (re)deploys; these are built-in and can't be edited or
// deleted from here (they live in git, not the DB). Keep in sync with CORE_SLUGS.
const CORE_FUNCTIONS: { slug: string; description: string }[] = [
  { slug: 'chat', description: 'The AI chat assistant — runs the agentic tool loop and streams replies.' },
  { slug: 'webhook', description: 'Public ingress — runs a prompt, agent, or tool against incoming payloads.' },
  { slug: 'mcp', description: 'MCP server an external Claude connects to (build agents/tools/artifacts).' },
  { slug: 'mcp-oauth', description: 'OAuth 2.1 authorization server for the MCP connector (paste-URL-and-approve).' },
  { slug: 'scheduler', description: 'Runs scheduled agents on the cron tick.' },
  { slug: 'ingest', description: 'Extracts, chunks, and embeds uploaded PDFs for knowledge search.' },
  { slug: 'email-inbound', description: 'Public inbound-email sink — normalizes incoming mail into the inbox.' },
  { slug: 'email-test', description: 'Admin “send a test email” for Settings → Email.' },
  { slug: 'p', description: 'Serves a shared HTML artifact as a standalone public page.' },
  { slug: 'forge', description: 'Generates, deploys, and maintains edge functions (this page).' },
  { slug: 'loop', description: 'Drives a goal-directed agent run with scored feedback iterations.' },
  { slug: 'evals', description: 'Runs an eval suite against the orchestrator and scores it.' },
  { slug: 'openrouter-balance', description: 'Proxies the OpenRouter account balance for the Usage page.' },
]

const STATUS_STYLE: Record<string, string> = {
  deployed: 'bg-emerald-100 text-emerald-700',
  failed: 'bg-red-100 text-red-700',
  disabled: 'bg-surface-2 text-muted',
  draft: 'bg-amber-100 text-amber-700',
}

export default function ForgePage() {
  const { user } = useAuth()
  const [rows, setRows] = useState<Forged[]>([])
  const [isAdmin, setIsAdmin] = useState(false)
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [viewing, setViewing] = useState<Forged | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  const load = useCallback(async () => {
    const { data } = await supabase
      .from('forged_functions')
      .select('*')
      .order('updated_at', { ascending: false })
    setRows(data ?? [])
    setLoading(false)
  }, [])

  useEffect(() => {
    load()
  }, [load])

  useEffect(() => {
    if (!user) return
    supabase
      .from('profiles')
      .select('is_admin')
      .eq('id', user.id)
      .maybeSingle()
      .then(({ data }) => setIsAdmin(Boolean(data?.is_admin)))
  }, [user])

  async function redeploy(row: Forged) {
    setBusyId(row.id)
    try {
      await redeployFunction(row.id)
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Redeploy failed')
    }
    setBusyId(null)
    load()
  }

  async function remove(row: Forged) {
    if (!confirm(`Delete and undeploy “${row.slug}”? This removes the function and its tool.`)) return
    setBusyId(row.id)
    try {
      await deleteForgedFunction(row.id)
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Delete failed')
    }
    setBusyId(null)
    load()
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl px-6 py-8">
        <div className="mb-1 flex items-center justify-between">
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight text-text">
            <ForgeIcon className="h-6 w-6 text-primary" /> Forge
          </h1>
          {isAdmin && (
            <button
              onClick={() => setCreating(true)}
              className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white hover:bg-primary-strong"
            >
              <PlusIcon className="h-4 w-4" /> Forge a tool
            </button>
          )}
        </div>
        <p className="mb-6 text-sm text-muted">
          Describe a capability and Forge writes a real edge function, deploys it to this project,
          and registers it as a tool any agent can call — a calculator, a custom API, a precise
          transform the model can’t reliably do itself.
        </p>

        {loading ? (
          <p className="text-sm text-faint">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-faint">
            {isAdmin ? 'No forged functions yet. Forge your first tool.' : 'No forged functions yet.'}
          </p>
        ) : (
          <div className="space-y-3">
            {rows.map((r) => (
              <div key={r.id} className="rounded-xl border border-border bg-surface p-4">
                <div className="flex items-center gap-3">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-muted">
                    <ForgeIcon className="h-5 w-5" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-mono text-sm font-medium text-text">{r.slug}</span>
                      <span
                        className={`rounded-full px-2 py-0.5 text-[10px] uppercase tracking-wide ${
                          STATUS_STYLE[r.status] ?? 'bg-surface-2 text-muted'
                        }`}
                      >
                        {r.status}
                      </span>
                    </div>
                    <p className="mt-0.5 line-clamp-1 text-xs text-muted">{r.spec || r.name}</p>
                  </div>
                  <button
                    onClick={() => setViewing(r)}
                    className="rounded-md px-2 py-1 text-xs font-medium text-muted hover:bg-surface-hover"
                  >
                    Source
                  </button>
                  {isAdmin && (
                    <>
                      <button
                        onClick={() => redeploy(r)}
                        disabled={busyId === r.id}
                        title="Redeploy stored source"
                        className="rounded-md p-1.5 text-muted hover:bg-surface-hover disabled:opacity-50"
                      >
                        <PlayIcon className="h-[18px] w-[18px]" />
                      </button>
                      <button
                        onClick={() => remove(r)}
                        disabled={busyId === r.id}
                        title="Delete + undeploy"
                        className="rounded-md p-1.5 text-faint hover:bg-red-50 hover:text-red-600 disabled:opacity-50"
                      >
                        <TrashIcon className="h-[18px] w-[18px]" />
                      </button>
                    </>
                  )}
                </div>
                {r.status === 'failed' && r.deploy_error && (
                  <p className="mt-2 rounded-md bg-red-50 px-3 py-2 text-xs text-red-600">{r.deploy_error}</p>
                )}
              </div>
            ))}
          </div>
        )}
        {!isAdmin && !loading && (
          <p className="mt-4 text-xs text-faint">Only an admin can forge or change functions.</p>
        )}

        {isAdmin && <DeployMaintenance onForgedRedeployed={load} />}
        {isAdmin && <CoreFunctionsList />}
      </div>

      {creating && <ForgeCreator onClose={() => setCreating(false)} onDone={() => { setCreating(false); load() }} />}
      {viewing && <SourceViewer row={viewing} onClose={() => setViewing(null)} />}
    </div>
  )
}

// Admin maintenance: redeploy edge functions from inside the app. Edge functions
// don't auto-deploy from main, so these buttons close that gap — "core" pushes
// the repo functions bundled into the UI at build time; "forged" re-pushes the
// stored source of every vibe-coded function.
function DeployMaintenance({ onForgedRedeployed }: { onForgedRedeployed: () => void }) {
  const [busy, setBusy] = useState<null | 'core' | 'forged'>(null)
  const [results, setResults] = useState<{ label: string; rows: DeployResultRow[] } | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function run(kind: 'core' | 'forged') {
    if (kind === 'core' && !confirm('Redeploy all core edge functions (chat, mcp, webhook, scheduler, …) from the current app build?')) return
    setBusy(kind)
    setError(null)
    setResults(null)
    try {
      const res = kind === 'core' ? await deployCore() : await redeployAllForged()
      setResults({ label: kind === 'core' ? 'Core functions' : 'Forged functions', rows: res.results })
      if (kind === 'forged') onForgedRedeployed()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Deploy failed')
    }
    setBusy(null)
  }

  const failed = results?.rows.filter((r) => !r.ok) ?? []
  const okCount = (results?.rows.length ?? 0) - failed.length

  return (
    <div className="mt-10 rounded-xl border border-border bg-surface p-5">
      <h2 className="text-sm font-semibold text-text">Deploy maintenance</h2>
      <p className="mt-1 text-xs text-muted">
        Redeploy edge functions from inside the app: “core” pushes this app’s built-in functions from
        the current build; “forged” re-pushes every vibe-coded function’s stored source.
      </p>
      <p className="mt-2 text-xs text-muted">
        This is a manual fallback and is <strong>optional</strong>: pushing to the <code>release</code>{' '}
        branch already deploys edge functions to every tenant automatically. To enable the buttons
        below, add a <code>FORGE_PAT</code> edge-function secret (a Supabase Management API access
        token) to this project — without it you’ll see “In-app deploy is not set up on this project”.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          onClick={() => run('core')}
          disabled={busy !== null}
          className="rounded-lg bg-slate-800 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-900 disabled:opacity-50"
        >
          {busy === 'core' ? 'Deploying core…' : 'Update core functions'}
        </button>
        <button
          onClick={() => run('forged')}
          disabled={busy !== null}
          className="rounded-lg border border-border-strong px-4 py-2 text-sm font-semibold text-muted hover:bg-surface-hover disabled:opacity-50"
        >
          {busy === 'forged' ? 'Redeploying…' : 'Redeploy forged functions'}
        </button>
      </div>

      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}

      {results && (
        <div className="mt-3 text-sm">
          <p className="text-muted">
            {results.label}: <span className="font-semibold text-emerald-700">{okCount} ok</span>
            {failed.length > 0 && <span className="font-semibold text-red-600">, {failed.length} failed</span>}
          </p>
          {failed.length > 0 && (
            <ul className="mt-2 space-y-1">
              {failed.map((r) => (
                <li key={r.slug} className="rounded-md bg-red-50 px-3 py-2 text-xs text-red-700">
                  <span className="font-mono font-semibold">{r.slug}</span>: {r.error || `status ${r.status}`}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}

// Read-only list of the app's built-in core functions. Mirrors the forged-function
// cards above but carries no actions — these are deployed from git/the build, not
// editable or deletable here. It just lets an admin see what the "Update core
// functions" button (re)deploys.
function CoreFunctionsList() {
  return (
    <div className="mt-6">
      <h2 className="text-sm font-semibold text-text">Core functions</h2>
      <p className="mt-1 text-xs text-muted">
        The app’s built-in edge functions that “Update core functions” redeploys. These ship with the
        app (from git) — read-only here, so they can’t be edited or deleted.
      </p>
      <div className="mt-3 space-y-3">
        {CORE_FUNCTIONS.map((f) => (
          <div key={f.slug} className="rounded-xl border border-border bg-surface p-4">
            <div className="flex items-center gap-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-muted">
                <ForgeIcon className="h-5 w-5" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate font-mono text-sm font-medium text-text">{f.slug}</span>
                  <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted">
                    Core
                  </span>
                </div>
                <p className="mt-0.5 line-clamp-1 text-xs text-muted">{f.description}</p>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function ForgeCreator({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [spec, setSpec] = useState('')
  const [preview, setPreview] = useState<GeneratedPreview | null>(null)
  const [slug, setSlug] = useState('')
  const [name, setName] = useState('')
  const [code, setCode] = useState('')
  const [generating, setGenerating] = useState(false)
  const [deploying, setDeploying] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function generate() {
    setGenerating(true)
    setError(null)
    try {
      const p = await generateFunction(spec)
      setPreview(p)
      setSlug(p.slug)
      setName(p.name)
      setCode(p.code)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Generation failed')
    }
    setGenerating(false)
  }

  async function deploy() {
    if (!preview) return
    setDeploying(true)
    setError(null)
    try {
      await deployFunction({
        slug,
        name,
        spec,
        code,
        input_schema: preview.input_schema,
        model: preview.model,
      })
      onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Deploy failed')
    }
    setDeploying(false)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/40 sm:items-center sm:p-4">
      <div className="flex max-h-[92vh] w-full max-w-2xl flex-col overflow-hidden rounded-t-2xl bg-surface shadow-xl sm:rounded-2xl">
        <div className="flex items-center justify-between border-b border-border px-5 py-3">
          <h2 className="text-sm font-semibold text-text">Forge a tool</h2>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto p-5">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted">Describe the capability</span>
            <textarea
              value={spec}
              onChange={(e) => setSpec(e.target.value)}
              rows={3}
              placeholder="e.g. Compute a mortgage amortization schedule from principal, annual rate, and term in years."
              className="w-full resize-y rounded-lg border border-border-strong px-3 py-2 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary-soft"
            />
          </label>
          <button
            onClick={generate}
            disabled={generating || !spec.trim()}
            className="rounded-lg bg-slate-800 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-900 disabled:opacity-50"
          >
            {generating ? 'Generating…' : preview ? 'Regenerate' : 'Generate & preview'}
          </button>

          {preview && (
            <div className="space-y-4 border-t border-border pt-4">
              {preview.summary && <p className="text-sm text-muted">{preview.summary}</p>}
              <div className="flex gap-3">
                <label className="block flex-1">
                  <span className="mb-1 block text-xs font-medium text-muted">Slug (function + tool name)</span>
                  <input
                    value={slug}
                    onChange={(e) => setSlug(e.target.value)}
                    className="w-full rounded-lg border border-border-strong px-3 py-2 font-mono text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary-soft"
                  />
                </label>
                <label className="block flex-1">
                  <span className="mb-1 block text-xs font-medium text-muted">Name</span>
                  <input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    className="w-full rounded-lg border border-border-strong px-3 py-2 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary-soft"
                  />
                </label>
              </div>
              {preview.slug_error && <p className="text-xs text-amber-600">{preview.slug_error}</p>}
              {preview.warnings.length > 0 && (
                <div className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-700">
                  This code will be rejected on deploy: {preview.warnings.join('; ')}.
                </div>
              )}
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-muted">
                  Generated code — defines <code>handler(input)</code>. A fixed harness adds request handling.
                </span>
                <textarea
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  rows={14}
                  spellCheck={false}
                  className="w-full resize-y rounded-lg border border-border-strong bg-surface-2 px-3 py-2 font-mono text-[12px] leading-relaxed outline-none focus:border-primary focus:ring-2 focus:ring-primary-soft"
                />
              </label>
            </div>
          )}

          {error && <p className="text-sm text-red-600">{error}</p>}
        </div>

        <div className="flex justify-end gap-2 border-t border-border px-5 py-3">
          <button onClick={onClose} className="rounded-lg px-3 py-2 text-sm font-medium text-muted hover:bg-surface-hover">
            Cancel
          </button>
          <button
            onClick={deploy}
            disabled={!preview || deploying || !slug.trim() || !code.trim()}
            className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white hover:bg-primary-strong disabled:opacity-50"
          >
            {deploying ? 'Deploying…' : 'Deploy'}
          </button>
        </div>
      </div>
    </div>
  )
}

function SourceViewer({ row, onClose }: { row: Forged; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/40 sm:items-center sm:p-4">
      <div className="flex max-h-[92vh] w-full max-w-2xl flex-col overflow-hidden rounded-t-2xl bg-surface shadow-xl sm:rounded-2xl">
        <div className="flex items-center justify-between border-b border-border px-5 py-3">
          <h2 className="font-mono text-sm font-semibold text-text">{row.slug}</h2>
          <button onClick={onClose} className="rounded-md px-3 py-1 text-sm font-medium text-muted hover:bg-surface-hover">
            Close
          </button>
        </div>
        <pre className="flex-1 overflow-auto bg-slate-900 p-5 text-[12px] leading-relaxed text-slate-100">
          <code>{row.source}</code>
        </pre>
      </div>
    </div>
  )
}
