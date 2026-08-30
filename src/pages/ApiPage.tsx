import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import type { Database } from '../lib/database.types'
import { artifactsApiUrl, todosApiUrl, runToolUrl, supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import { formatDate } from '../lib/util'
import { CheckIcon, CopyIcon, PlusIcon } from '../components/icons'

type McpToken = Database['public']['Tables']['mcp_tokens']['Row']

// The API area is built around tabs so we can add more surfaces here over time
// (Collections, Files, …). For now it holds the Artifacts CRUD API.
const TABS = [
  { id: 'artifacts', label: 'Artifacts' },
  { id: 'todos', label: 'To-dos' },
  { id: 'tools', label: 'Run tools' },
] as const
type TabId = (typeof TABS)[number]['id']

export default function ApiPage() {
  const [active, setActive] = useState<TabId>('artifacts')

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl px-6 py-8">
        <h1 className="text-2xl font-semibold tracking-tight text-text">API</h1>
        <p className="mt-1 text-sm text-muted">
          Push and sync content into this workspace from anywhere with a simple REST API and a bearer
          token. More endpoints coming soon.
        </p>

        <div className="mt-5 flex gap-1 border-b border-border">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setActive(t.id)}
              className={`-mb-px border-b-2 px-4 py-2 text-sm font-semibold transition ${
                active === t.id
                  ? 'border-primary text-primary'
                  : 'border-transparent text-muted hover:text-text'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {active === 'artifacts' && <ArtifactsApiTab />}
        {active === 'todos' && <TodosApiTab />}
        {active === 'tools' && <ToolsApiTab />}
      </div>
    </div>
  )
}

/** A dark code block with a copy button. */
function CodeBlock({ code, label }: { code: string; label?: string }) {
  const [copied, setCopied] = useState(false)
  async function copy() {
    await navigator.clipboard.writeText(code)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }
  return (
    <div className="group relative">
      {label && <p className="mb-1 text-xs font-medium text-muted">{label}</p>}
      <div className="flex items-start gap-2">
        <pre className="min-w-0 flex-1 overflow-x-auto rounded-lg bg-slate-900 p-3 text-[12px] leading-relaxed text-slate-100">
          {code}
        </pre>
        <button
          onClick={copy}
          className="shrink-0 rounded-lg border border-border-strong px-2 py-1.5 text-xs font-medium text-muted hover:bg-surface-hover"
          title="Copy"
        >
          {copied ? <CheckIcon className="h-4 w-4" /> : <CopyIcon className="h-3.5 w-3.5" />}
        </button>
      </div>
    </div>
  )
}

const ENDPOINTS: Array<{ method: string; path: string; desc: string }> = [
  { method: 'GET', path: '/artifacts', desc: 'List your artifacts (filters below).' },
  { method: 'POST', path: '/artifacts', desc: 'Create an artifact.' },
  { method: 'GET', path: '/artifacts/:id', desc: 'Read one (with content + collections).' },
  { method: 'PATCH', path: '/artifacts/:id', desc: 'Update fields you send; add collection tags.' },
  { method: 'DELETE', path: '/artifacts/:id', desc: 'Delete one.' },
]

const TODO_ENDPOINTS: Array<{ method: string; path: string; desc: string }> = [
  { method: 'GET', path: '/todos', desc: 'List your to-dos (filters below).' },
  { method: 'POST', path: '/todos', desc: 'Create a to-do.' },
  { method: 'GET', path: '/todos/:id', desc: 'Read one (with its collections).' },
  { method: 'PATCH', path: '/todos/:id', desc: 'Update fields you send (done:true completes it); add collection tags.' },
  { method: 'DELETE', path: '/todos/:id', desc: 'Delete one.' },
]

const METHOD_COLORS: Record<string, string> = {
  GET: 'bg-emerald-100 text-emerald-700',
  POST: 'bg-blue-100 text-blue-700',
  PATCH: 'bg-amber-100 text-amber-700',
  DELETE: 'bg-red-100 text-red-700',
}

function ArtifactsApiTab() {
  const { user } = useAuth()
  const [tokens, setTokens] = useState<McpToken[]>([])
  const [selected, setSelected] = useState<string>('')
  const [creating, setCreating] = useState(false)

  const load = useCallback(async () => {
    const { data } = await supabase
      .from('mcp_tokens')
      .select('*')
      .order('created_at', { ascending: false })
    setTokens(data ?? [])
    // Default the curl examples to the most recent token if none chosen yet.
    setSelected((cur) => cur || (data && data[0]?.token) || '')
  }, [])

  useEffect(() => {
    load()
  }, [load])

  async function createToken() {
    if (!user) return
    setCreating(true)
    const { data } = await supabase
      .from('mcp_tokens')
      .insert({ owner_id: user.id, name: 'API' })
      .select('*')
      .single()
    setCreating(false)
    if (data) {
      await load()
      setSelected(data.token)
    }
  }

  // The token to drop into examples: the real one if chosen, else a placeholder.
  const tokenForExamples = selected || '$TOKEN'
  const base = artifactsApiUrl

  const createExample =
    `curl -X POST "${base}" \\\n` +
    `  -H "Authorization: Bearer ${tokenForExamples}" \\\n` +
    `  -H "Content-Type: application/json" \\\n` +
    `  -d '{"title":"Hello","content":"# Hi","type":"markdown","collection":"Blog"}'`

  const listExample = `curl "${base}?collection=Blog" \\\n  -H "Authorization: Bearer ${tokenForExamples}"`

  const readExample = `curl "${base}/<id>" \\\n  -H "Authorization: Bearer ${tokenForExamples}"`

  const updateExample =
    `curl -X PATCH "${base}/<id>" \\\n` +
    `  -H "Authorization: Bearer ${tokenForExamples}" \\\n` +
    `  -H "Content-Type: application/json" \\\n` +
    `  -d '{"content":"# Updated","visibility":"public"}'`

  const deleteExample = `curl -X DELETE "${base}/<id>" \\\n  -H "Authorization: Bearer ${tokenForExamples}"`

  return (
    <div className="mt-6 space-y-6">
      {/* Intro */}
      <section className="rounded-xl border border-border bg-surface p-5">
        <h2 className="text-sm font-semibold text-text">Artifacts CRUD API</h2>
        <p className="mt-1 text-sm text-muted">
          Create, read, update, and delete artifacts (docs / code / HTML / text) over plain REST — from
          a script, a Zap, a cron job, or any other system. Tag each one into a{' '}
          <strong>collection</strong> (the named groups you chat with) by name or id; the collection is
          created if it doesn’t exist.
        </p>
        <div className="mt-3">
          <span className="mb-1 block text-xs font-medium text-muted">Base URL</span>
          <CodeBlock code={base} />
        </div>
      </section>

      {/* Auth / tokens */}
      <section className="rounded-xl border border-border bg-surface p-5">
        <h2 className="text-sm font-semibold text-text">Authentication</h2>
        <p className="mt-1 text-sm text-muted">
          Send a personal bearer token in the <code className="rounded bg-surface-2 px-1">Authorization</code>{' '}
          header. These are the same connection tokens as{' '}
          <Link to="/settings" className="font-medium text-primary hover:underline">
            Settings → Connect Claude
          </Link>
          . Every call runs as you — you only ever see and modify your own artifacts. Treat a token like
          a password; revoke it in Settings if it leaks.
        </p>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          {tokens.length > 0 ? (
            <label className="flex items-center gap-2 text-sm text-muted">
              Use token in examples:
              <select
                value={selected}
                onChange={(e) => setSelected(e.target.value)}
                className="rounded-lg border border-border-strong bg-surface px-2 py-1.5 text-sm outline-none focus:border-primary"
              >
                {tokens.map((t) => (
                  <option key={t.id} value={t.token}>
                    {t.name} · {t.last_used_at ? `used ${formatDate(t.last_used_at)}` : 'never used'}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <span className="text-sm text-muted">No tokens yet — create one to get ready-to-run examples.</span>
          )}
          <button
            onClick={createToken}
            disabled={creating}
            className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-sm font-semibold text-white hover:bg-primary-strong disabled:opacity-60"
          >
            <PlusIcon className="h-4 w-4" /> {creating ? 'Creating…' : 'New token'}
          </button>
        </div>
        {selected && (
          <p className="mt-2 text-[11px] text-faint">
            The examples below include your selected token so they’re ready to paste. Keep them private.
          </p>
        )}
      </section>

      {/* Endpoints */}
      <section className="rounded-xl border border-border bg-surface p-5">
        <h2 className="text-sm font-semibold text-text">Endpoints</h2>
        <div className="mt-3 overflow-hidden rounded-lg border border-border">
          <table className="w-full text-left text-sm">
            <tbody>
              {ENDPOINTS.map((e, i) => (
                <tr key={e.method + e.path} className={i > 0 ? 'border-t border-border' : ''}>
                  <td className="whitespace-nowrap px-3 py-2 align-top">
                    <span
                      className={`inline-block rounded px-1.5 py-0.5 text-[11px] font-bold ${
                        METHOD_COLORS[e.method] ?? 'bg-surface-2 text-muted'
                      }`}
                    >
                      {e.method}
                    </span>
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 align-top font-mono text-[12px] text-text">
                    {e.path}
                  </td>
                  <td className="px-3 py-2 align-top text-muted">{e.desc}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-xs text-muted">
          List filters (query params): <code className="rounded bg-surface-2 px-1">collection</code>,{' '}
          <code className="rounded bg-surface-2 px-1">type</code>,{' '}
          <code className="rounded bg-surface-2 px-1">q</code>,{' '}
          <code className="rounded bg-surface-2 px-1">include=content</code>,{' '}
          <code className="rounded bg-surface-2 px-1">limit</code>,{' '}
          <code className="rounded bg-surface-2 px-1">offset</code>.
        </p>
      </section>

      {/* Request body reference */}
      <section className="rounded-xl border border-border bg-surface p-5">
        <h2 className="text-sm font-semibold text-text">Create / update body</h2>
        <div className="mt-3 overflow-hidden rounded-lg border border-border">
          <table className="w-full text-left text-sm">
            <thead className="bg-surface-2 text-xs text-muted">
              <tr>
                <th className="px-3 py-2 font-medium">Field</th>
                <th className="px-3 py-2 font-medium">Notes</th>
              </tr>
            </thead>
            <tbody className="text-muted">
              {[
                ['title', 'Required on create.'],
                ['content', 'Required on create. The artifact body.'],
                ['type', 'markdown (default) | code | html | text.'],
                ['language', 'Optional hint for code artifacts.'],
                ['visibility', 'private (default) | unlisted | public. Non-private mints a public_slug.'],
                ['collection', 'Collection name or id to file into — created if missing.'],
                ['collections', 'Array of names/ids, same rules (additive).'],
              ].map(([field, note], i) => (
                <tr key={field} className={i > 0 ? 'border-t border-border' : ''}>
                  <td className="whitespace-nowrap px-3 py-2 align-top font-mono text-[12px] text-text">
                    {field}
                  </td>
                  <td className="px-3 py-2 align-top">{note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-xs text-muted">
          On update, only the fields you send change; passing <code className="rounded bg-surface-2 px-1">collection</code>/
          <code className="rounded bg-surface-2 px-1">collections</code> <strong>adds</strong> tags (existing ones are kept).
        </p>
      </section>

      {/* Examples */}
      <section className="rounded-xl border border-border bg-surface p-5">
        <h2 className="text-sm font-semibold text-text">Examples</h2>
        <div className="mt-3 space-y-4">
          <CodeBlock label="Create a markdown artifact and tag it into “Blog”" code={createExample} />
          <CodeBlock label="List artifacts in a collection" code={listExample} />
          <CodeBlock label="Read one with its content" code={readExample} />
          <CodeBlock label="Update content and publish it" code={updateExample} />
          <CodeBlock label="Delete" code={deleteExample} />
        </div>
        <p className="mt-4 text-xs text-muted">
          Tip: opening{' '}
          <a
            href={`${base}/docs`}
            target="_blank"
            rel="noreferrer"
            className="font-medium text-primary hover:underline"
          >
            {base}/docs
          </a>{' '}
          returns these docs as plain text, so they’re reachable straight from the endpoint too.
        </p>
      </section>
    </div>
  )
}

function ToolsApiTab() {
  const { user } = useAuth()
  const [tokens, setTokens] = useState<McpToken[]>([])
  const [selected, setSelected] = useState<string>('')
  const [creating, setCreating] = useState(false)
  const [toolNames, setToolNames] = useState<Array<{ name: string; kind: string }>>([])

  const load = useCallback(async () => {
    const [tRes, toolsRes] = await Promise.all([
      supabase.from('mcp_tokens').select('*').order('created_at', { ascending: false }),
      supabase.from('tools').select('name, kind').eq('is_active', true).neq('kind', 'web').order('name'),
    ])
    setTokens(tRes.data ?? [])
    setSelected((cur) => cur || (tRes.data && tRes.data[0]?.token) || '')
    setToolNames(toolsRes.data ?? [])
  }, [])

  useEffect(() => {
    load()
  }, [load])

  async function createToken() {
    if (!user) return
    setCreating(true)
    const { data } = await supabase.from('mcp_tokens').insert({ owner_id: user.id, name: 'API' }).select('*').single()
    setCreating(false)
    if (data) {
      await load()
      setSelected(data.token)
    }
  }

  const tokenForExamples = selected || '$TOKEN'
  const base = runToolUrl

  const runExample =
    `curl -X POST "${base}" \\\n` +
    `  -H "Authorization: Bearer ${tokenForExamples}" \\\n` +
    `  -H "Content-Type: application/json" \\\n` +
    `  -d '{"tool":"list_todos","input":{"status":"open"}}'`

  const chainExample =
    `curl -X POST "${base}" \\\n` +
    `  -H "Authorization: Bearer ${tokenForExamples}" \\\n` +
    `  -H "Content-Type: application/json" \\\n` +
    `  -d '{"steps":[\n` +
    `    {"tool":"http_request","input":{"url":"https://example.com"}},\n` +
    `    {"tool":"add_note","input":{"title":"Example page","content":"{{prev}}"}}\n` +
    `  ]}'`

  const listExample = `curl "${base}/list" \\\n  -H "Authorization: Bearer ${tokenForExamples}"`

  return (
    <div className="mt-6 space-y-6">
      <section className="rounded-xl border border-border bg-surface p-5">
        <h2 className="text-sm font-semibold text-text">Run tools directly</h2>
        <p className="mt-1 text-sm text-muted">
          Invoke any <strong>active tool</strong> — the same builtins, custom HTTP tools, and MCP remote tools the
          assistant uses — from a script, a cron job, or a Zap, with <strong>no model in the loop</strong>. Chain
          several with a <code className="rounded bg-surface-2 px-1">steps</code> array;{' '}
          <code className="rounded bg-surface-2 px-1">{'{{prev}}'}</code> inside any string input is replaced with the
          previous step&apos;s result.
        </p>
        <div className="mt-3">
          <span className="mb-1 block text-xs font-medium text-muted">Base URL</span>
          <CodeBlock code={base} />
        </div>
      </section>

      <section className="rounded-xl border border-border bg-surface p-5">
        <h2 className="text-sm font-semibold text-text">Authentication</h2>
        <p className="mt-1 text-sm text-muted">
          Send a personal bearer token in the <code className="rounded bg-surface-2 px-1">Authorization</code> header —
          the same connection tokens as{' '}
          <Link to="/settings" className="font-medium text-primary hover:underline">
            Settings → Connect Claude
          </Link>
          . Every call runs as you: private/workspace access rules apply exactly as they do in chat.
        </p>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          {tokens.length > 0 ? (
            <label className="flex items-center gap-2 text-sm text-muted">
              Use token in examples:
              <select
                value={selected}
                onChange={(e) => setSelected(e.target.value)}
                className="rounded-lg border border-border-strong bg-surface px-2 py-1.5 text-sm outline-none focus:border-primary"
              >
                {tokens.map((t) => (
                  <option key={t.id} value={t.token}>
                    {t.name} · {t.last_used_at ? `used ${formatDate(t.last_used_at)}` : 'never used'}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <span className="text-sm text-muted">No tokens yet — create one to get ready-to-run examples.</span>
          )}
          <button
            onClick={createToken}
            disabled={creating}
            className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-sm font-semibold text-white hover:bg-primary-strong disabled:opacity-60"
          >
            <PlusIcon className="h-4 w-4" /> {creating ? 'Creating…' : 'New token'}
          </button>
        </div>
      </section>

      <section className="rounded-xl border border-border bg-surface p-5">
        <h2 className="text-sm font-semibold text-text">Runnable tools right now</h2>
        <p className="mt-1 text-sm text-muted">
          Everything active on the{' '}
          <Link to="/tools" className="font-medium text-primary hover:underline">
            Tools page
          </Link>{' '}
          (MCP entries are server handles — call their remote tools by namespaced name, e.g.{' '}
          <code className="rounded bg-surface-2 px-1">zapier__gmail_find_email</code>).
        </p>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {toolNames.map((t) => (
            <span
              key={t.name}
              className="rounded-full bg-surface-2 px-2.5 py-1 font-mono text-[11px] text-muted"
              title={t.kind}
            >
              {t.name}
            </span>
          ))}
          {toolNames.length === 0 && <span className="text-sm text-faint">No active tools.</span>}
        </div>
      </section>

      <section className="rounded-xl border border-border bg-surface p-5">
        <h2 className="text-sm font-semibold text-text">Examples</h2>
        <div className="mt-3 space-y-4">
          <CodeBlock label="Run one tool" code={runExample} />
          <CodeBlock label="Chain: fetch a page (as markdown), save it to the knowledge base" code={chainExample} />
          <CodeBlock label="List runnable tools with their input schemas" code={listExample} />
        </div>
        <p className="mt-4 text-xs text-muted">
          Tip: opening{' '}
          <a href={`${base}/docs`} target="_blank" rel="noreferrer" className="font-medium text-primary hover:underline">
            {base}/docs
          </a>{' '}
          returns these docs as plain text too.
        </p>
      </section>
    </div>
  )
}

function TodosApiTab() {
  const { user } = useAuth()
  const [tokens, setTokens] = useState<McpToken[]>([])
  const [selected, setSelected] = useState<string>('')
  const [creating, setCreating] = useState(false)

  const load = useCallback(async () => {
    const { data } = await supabase.from('mcp_tokens').select('*').order('created_at', { ascending: false })
    setTokens(data ?? [])
    setSelected((cur) => cur || (data && data[0]?.token) || '')
  }, [])

  useEffect(() => {
    load()
  }, [load])

  async function createToken() {
    if (!user) return
    setCreating(true)
    const { data } = await supabase.from('mcp_tokens').insert({ owner_id: user.id, name: 'API' }).select('*').single()
    setCreating(false)
    if (data) {
      await load()
      setSelected(data.token)
    }
  }

  const tokenForExamples = selected || '$TOKEN'
  const base = todosApiUrl

  const createExample =
    `curl -X POST "${base}" \\\n` +
    `  -H "Authorization: Bearer ${tokenForExamples}" \\\n` +
    `  -H "Content-Type: application/json" \\\n` +
    `  -d '{"title":"Ship the thing","due_date":"2026-07-01","status":"next","collection":"Work"}'`

  const listExample = `curl "${base}?collection=Work&status=blocked&sort=due" \\\n  -H "Authorization: Bearer ${tokenForExamples}"`

  const readExample = `curl "${base}/<id>" \\\n  -H "Authorization: Bearer ${tokenForExamples}"`

  const completeExample =
    `curl -X PATCH "${base}/<id>" \\\n` +
    `  -H "Authorization: Bearer ${tokenForExamples}" \\\n` +
    `  -H "Content-Type: application/json" \\\n` +
    `  -d '{"done":true}'`

  const deleteExample = `curl -X DELETE "${base}/<id>" \\\n  -H "Authorization: Bearer ${tokenForExamples}"`

  return (
    <div className="mt-6 space-y-6">
      <section className="rounded-xl border border-border bg-surface p-5">
        <h2 className="text-sm font-semibold text-text">To-dos CRUD API</h2>
        <p className="mt-1 text-sm text-muted">
          Capture, list, complete, and delete to-dos over plain REST — from a script, a Zap, a cron job,
          or any other system. Set a <strong>due date</strong>, mark them <strong>done</strong>, and tag
          each into a <strong>collection</strong> (the named groups you chat with) by name or id.
        </p>
        <div className="mt-3">
          <span className="mb-1 block text-xs font-medium text-muted">Base URL</span>
          <CodeBlock code={base} />
        </div>
      </section>

      <section className="rounded-xl border border-border bg-surface p-5">
        <h2 className="text-sm font-semibold text-text">Authentication</h2>
        <p className="mt-1 text-sm text-muted">
          Send a personal bearer token in the <code className="rounded bg-surface-2 px-1">Authorization</code>{' '}
          header — the same connection tokens as{' '}
          <Link to="/settings" className="font-medium text-primary hover:underline">
            Settings → Connect Claude
          </Link>
          . Every call runs as you; you only see and modify your own to-dos.
        </p>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          {tokens.length > 0 ? (
            <label className="flex items-center gap-2 text-sm text-muted">
              Use token in examples:
              <select
                value={selected}
                onChange={(e) => setSelected(e.target.value)}
                className="rounded-lg border border-border-strong bg-surface px-2 py-1.5 text-sm outline-none focus:border-primary"
              >
                {tokens.map((t) => (
                  <option key={t.id} value={t.token}>
                    {t.name} · {t.last_used_at ? `used ${formatDate(t.last_used_at)}` : 'never used'}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <span className="text-sm text-muted">No tokens yet — create one to get ready-to-run examples.</span>
          )}
          <button
            onClick={createToken}
            disabled={creating}
            className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-sm font-semibold text-white hover:bg-primary-strong disabled:opacity-60"
          >
            <PlusIcon className="h-4 w-4" /> {creating ? 'Creating…' : 'New token'}
          </button>
        </div>
      </section>

      <section className="rounded-xl border border-border bg-surface p-5">
        <h2 className="text-sm font-semibold text-text">Endpoints</h2>
        <div className="mt-3 overflow-hidden rounded-lg border border-border">
          <table className="w-full text-left text-sm">
            <tbody>
              {TODO_ENDPOINTS.map((e, i) => (
                <tr key={e.method + e.path} className={i > 0 ? 'border-t border-border' : ''}>
                  <td className="whitespace-nowrap px-3 py-2 align-top">
                    <span
                      className={`inline-block rounded px-1.5 py-0.5 text-[11px] font-bold ${
                        METHOD_COLORS[e.method] ?? 'bg-surface-2 text-muted'
                      }`}
                    >
                      {e.method}
                    </span>
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 align-top font-mono text-[12px] text-text">{e.path}</td>
                  <td className="px-3 py-2 align-top text-muted">{e.desc}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-xs text-muted">
          List filters (query params): <code className="rounded bg-surface-2 px-1">collection</code>,{' '}
          <code className="rounded bg-surface-2 px-1">status=open|done</code> (or one lane:{' '}
          <code className="rounded bg-surface-2 px-1">triage|next|doing|blocked|done</code>),{' '}
          <code className="rounded bg-surface-2 px-1">q</code>,{' '}
          <code className="rounded bg-surface-2 px-1">sort=position|due</code>,{' '}
          <code className="rounded bg-surface-2 px-1">limit</code>,{' '}
          <code className="rounded bg-surface-2 px-1">offset</code>.
        </p>
      </section>

      <section className="rounded-xl border border-border bg-surface p-5">
        <h2 className="text-sm font-semibold text-text">Create / update body</h2>
        <div className="mt-3 overflow-hidden rounded-lg border border-border">
          <table className="w-full text-left text-sm">
            <thead className="bg-surface-2 text-xs text-muted">
              <tr>
                <th className="px-3 py-2 font-medium">Field</th>
                <th className="px-3 py-2 font-medium">Notes</th>
              </tr>
            </thead>
            <tbody className="text-muted">
              {[
                ['title', 'Required on create.'],
                ['notes', 'Optional longer text.'],
                ['due_date', 'YYYY-MM-DD, or null to clear.'],
                ['status', 'Lifecycle lane: triage (default) | next | doing | blocked | done.'],
                ['done', 'true completes it (sets completed_at); false reopens. Same thing as status.'],
                ['visibility', 'private (default) | workspace (whole team can see & collaborate).'],
                ['collection', 'Collection name or id to file into — created if missing.'],
                ['collections', 'Array of names/ids, same rules (additive).'],
              ].map(([field, note], i) => (
                <tr key={field} className={i > 0 ? 'border-t border-border' : ''}>
                  <td className="whitespace-nowrap px-3 py-2 align-top font-mono text-[12px] text-text">{field}</td>
                  <td className="px-3 py-2 align-top">{note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-xs text-muted">
          On update, only the fields you send change; passing{' '}
          <code className="rounded bg-surface-2 px-1">collection</code>/
          <code className="rounded bg-surface-2 px-1">collections</code> <strong>adds</strong> tags (existing ones kept).
        </p>
        <p className="mt-2 text-xs text-muted">
          <code className="rounded bg-surface-2 px-1">status</code> and{' '}
          <code className="rounded bg-surface-2 px-1">done</code> are two views of the same thing and are kept
          consistent for you — send whichever you prefer, never both. Responses also carry a read-only{' '}
          <code className="rounded bg-surface-2 px-1">source</code> (<code className="rounded bg-surface-2 px-1">api</code>,{' '}
          <code className="rounded bg-surface-2 px-1">agent</code>, or null when a person added it).
        </p>
      </section>

      <section className="rounded-xl border border-border bg-surface p-5">
        <h2 className="text-sm font-semibold text-text">Examples</h2>
        <div className="mt-3 space-y-4">
          <CodeBlock label="Create a to-do with a due date and tag it into “Work”" code={createExample} />
          <CodeBlock label="List open to-dos in a collection, by due date" code={listExample} />
          <CodeBlock label="Read one with its collections" code={readExample} />
          <CodeBlock label="Mark one done" code={completeExample} />
          <CodeBlock label="Delete" code={deleteExample} />
        </div>
        <p className="mt-4 text-xs text-muted">
          Tip: opening{' '}
          <a href={`${base}/docs`} target="_blank" rel="noreferrer" className="font-medium text-primary hover:underline">
            {base}/docs
          </a>{' '}
          returns these docs as plain text too.
        </p>
      </section>
    </div>
  )
}
