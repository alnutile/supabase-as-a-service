// Supabase Edge Function: `forge` (verify_jwt=true, ADMIN ONLY).
// The factory that vibe-codes new edge functions from inside the app: it
// generates a Deno function from a natural-language spec, validates and deploys
// it to the live project via the Management API, then registers it as a custom
// `http` tool so every agent loop (chat/webhook/scheduler) can call it.
//
// Actions (POST { action, ... }):
//   generate  { spec }                         → model writes handler code; returns a preview (no deploy)
//   deploy    { slug, name, spec, code, input_schema } → lint → bundle-check → deploy → register tool
//   redeploy  { id }                           → redeploy the stored source for a forged function
//   delete    { id }                           → undeploy + remove the tool + the row
//
// Forge fails CLOSED: any guardrail block/error, lint hit, or bundle failure
// aborts before anything is deployed. The PAT lives only in _shared/management.ts.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4'
import { resolveModel } from '../_shared/models.ts'
import { runGuardrails } from '../_shared/guardrails.ts'
import { orApiKey, orComplete, systemMsg } from '../_shared/openrouter.ts'
import { recordUsage } from '../_shared/usage.ts'
import { deleteFunction, deployFunction, managementConfigured } from '../_shared/management.ts'
import { buildModule, generatorSystem, lintSource, validateSlug } from './template.ts'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''

// The app's own repo functions that `deploy_core` is allowed to (re)deploy.
// An allow-list so this admin path can never deploy an arbitrary slug.
const CORE_SLUGS = new Set([
  'chat',
  'webhook',
  'mcp',
  'scheduler',
  'ingest',
  'email-inbound',
  'email-test',
  'mcp-admin',
  'p',
  'artifacts',
  'todos',
  'forge',
  'loop',
  'evals',
  'openrouter-balance',
])

function admin() {
  const url = Deno.env.get('SUPABASE_URL')
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  return url && key ? createClient(url, key) : null
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })
}

// verify_jwt=true validated the token upstream; we only read the sub claim.
function userIdFromAuth(req: Request): string | null {
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '')
  const parts = token.split('.')
  if (parts.length < 2) return null
  try {
    const j = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')))
    return typeof j.sub === 'string' ? j.sub : null
  } catch {
    return null
  }
}

// deno-lint-ignore no-explicit-any
async function isAdmin(db: any, userId: string): Promise<boolean> {
  const { data } = await db.from('profiles').select('is_admin').eq('id', userId).maybeSingle()
  return Boolean(data?.is_admin)
}

function randomToken(): string {
  const bytes = new Uint8Array(24)
  crypto.getRandomValues(bytes)
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}

interface Generated {
  slug: string
  name: string
  summary: string
  input_schema: Record<string, unknown>
  code: string
}

// Ask the orchestrator model to write the handler module from a spec.
// deno-lint-ignore no-explicit-any
async function generate(db: any, model: string, spec: string, actorId: string | null): Promise<Generated> {
  const out = await orComplete({
    model,
    maxTokens: 8000,
    messages: [systemMsg(generatorSystem()), { role: 'user', content: spec }],
  })
  await recordUsage(db, { context: 'forge', model, actorId, usage: out.usage })
  const start = out.content.indexOf('{')
  const end = out.content.lastIndexOf('}')
  if (start === -1 || end === -1 || end < start) throw new Error('Model did not return JSON.')
  // deno-lint-ignore no-explicit-any
  let parsed: any
  try {
    parsed = JSON.parse(out.content.slice(start, end + 1))
  } catch {
    throw new Error('Model returned malformed JSON.')
  }
  if (typeof parsed.code !== 'string' || !parsed.code.trim()) throw new Error('Model returned no code.')
  return {
    slug: String(parsed.slug ?? '').trim(),
    name: String(parsed.name ?? parsed.slug ?? 'Forged function').trim(),
    summary: String(parsed.summary ?? '').trim(),
    input_schema:
      parsed.input_schema && typeof parsed.input_schema === 'object'
        ? parsed.input_schema
        : { type: 'object', properties: {} },
    code: parsed.code,
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return json({ error: 'Use POST' }, 405)

  if (!orApiKey()) return json({ error: 'OPENROUTER_API_KEY is not configured' }, 500)
  const db = admin()
  if (!db) return json({ error: 'Server not configured' }, 500)

  const userId = userIdFromAuth(req)
  if (!userId || !(await isAdmin(db, userId))) return json({ error: 'Admin only' }, 403)

  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return json({ error: 'Bad request body' }, 400)
  }
  const action = String(body.action ?? '')

  // --- generate: produce a preview from a spec, no deploy ---
  if (action === 'generate') {
    const spec = String(body.spec ?? '').trim()
    if (!spec) return json({ error: 'Describe the capability first.' }, 400)
    try {
      const model = await resolveModel(db, 'orchestrator')
      const gen = await generate(db, model, spec, userId)
      const warnings = lintSource(gen.code)
      const slugError = gen.slug ? validateSlug(gen.slug) : 'Model did not propose a slug.'
      return json({ ...gen, model, warnings, slug_error: slugError })
    } catch (err) {
      return json({ error: err instanceof Error ? err.message : 'generation failed' }, 502)
    }
  }

  // --- deploy: validate + deploy caller-provided (possibly edited) code ---
  if (action === 'deploy') {
    if (!managementConfigured()) {
      return json({ error: 'Deploy is not configured: set the FORGE_PAT edge secret (project ref auto-derives from SUPABASE_URL).' }, 500)
    }
    const slug = String(body.slug ?? '').trim()
    const name = String(body.name ?? slug).trim()
    const spec = String(body.spec ?? '')
    const code = String(body.code ?? '')
    const model = body.model ? String(body.model) : null
    const inputSchema =
      body.input_schema && typeof body.input_schema === 'object'
        ? (body.input_schema as Record<string, unknown>)
        : { type: 'object', properties: {} }

    const slugError = validateSlug(slug)
    if (slugError) return json({ error: slugError }, 400)
    if (!code.trim()) return json({ error: 'No code to deploy.' }, 400)

    // Static lint (fail closed).
    const lint = lintSource(code)
    if (lint.length) return json({ error: `Code rejected: ${lint.join('; ')}.` }, 400)

    // Guardrail pre-flight over the code (fail closed for an admin write action).
    const guard = await runGuardrails(db, 'chat', code, userId)
    if (guard.ok === false && 'error' in guard) {
      await db.from('activity_log').insert({ type: 'forge.failed', summary: `Forge guardrail errored for "${slug}"`, detail: { error: guard.error }, actor_id: userId })
      return json({ error: `Guardrail evaluator error: ${guard.error}` }, 502)
    }
    if (guard.ok === false && guard.blocked) {
      await db.from('activity_log').insert({ type: 'guardrail.blocked', summary: `Blocked forge "${slug}" — ${guard.violations[0].name}`, detail: { violations: guard.violations }, actor_id: userId })
      return json({ error: `Blocked by guardrail: ${guard.violations[0].name}.` }, 403)
    }

    const invokeToken = randomToken()
    const source = buildModule(code, invokeToken)

    // Dry-run: bundle/compile WITHOUT persisting.
    const dry = await deployFunction({ slug, name, source, verifyJwt: false, bundleOnly: true })
    if (!dry.ok) return json({ error: `Bundle check failed (${dry.status}): ${dry.body}` }, 400)

    // Real deploy.
    const dep = await deployFunction({ slug, name, source, verifyJwt: false })
    if (!dep.ok) {
      await db.from('activity_log').insert({ type: 'forge.failed', summary: `Deploy failed for "${slug}"`, detail: { status: dep.status, body: dep.body }, actor_id: userId })
      return json({ error: `Deploy failed (${dep.status}): ${dep.body}` }, 502)
    }

    // Register the tool that exposes it to the agent loops.
    const { data: tool, error: toolErr } = await db
      .from('tools')
      .insert({
        name: slug,
        description: spec || `Forged function: ${name}`,
        kind: 'http',
        input_schema: inputSchema,
        config: { url: `${SUPABASE_URL}/functions/v1/${slug}`, method: 'POST', headers: { 'x-forge-token': invokeToken } },
        is_active: true,
        created_by: userId,
      })
      .select('id')
      .single()
    if (toolErr) return json({ error: `Deployed, but could not register tool: ${toolErr.message}` }, 500)

    // Upsert the audit/registry row (unique on slug → redeploys update in place).
    const { data: row, error: rowErr } = await db
      .from('forged_functions')
      .upsert(
        {
          slug,
          name,
          spec,
          source,
          model,
          input_schema: inputSchema,
          status: 'deployed',
          deploy_error: null,
          invoke_token: invokeToken,
          tool_id: tool!.id,
          created_by: userId,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'slug' },
      )
      .select('*')
      .single()
    if (rowErr) return json({ error: `Deployed and registered, but could not save record: ${rowErr.message}` }, 500)

    await db.from('activity_log').insert({ type: 'forge.deployed', summary: `Forged function "${slug}" deployed`, detail: { slug, tool_id: tool!.id }, actor_id: userId })
    return json({ ok: true, function: row, tool_id: tool!.id })
  }

  // --- redeploy: push the stored source again ---
  if (action === 'redeploy') {
    if (!managementConfigured()) return json({ error: 'Deploy not configured.' }, 500)
    const id = String(body.id ?? '')
    const { data: row } = await db.from('forged_functions').select('*').eq('id', id).maybeSingle()
    if (!row) return json({ error: 'Unknown function.' }, 404)
    const dep = await deployFunction({ slug: row.slug, name: row.name, source: row.source, verifyJwt: false })
    if (!dep.ok) {
      await db.from('forged_functions').update({ status: 'failed', deploy_error: `${dep.status}: ${dep.body}`.slice(0, 1000) }).eq('id', id)
      return json({ error: `Redeploy failed (${dep.status}): ${dep.body}` }, 502)
    }
    await db.from('forged_functions').update({ status: 'deployed', deploy_error: null, updated_at: new Date().toISOString() }).eq('id', id)
    await db.from('activity_log').insert({ type: 'forge.deployed', summary: `Redeployed "${row.slug}"`, detail: { slug: row.slug }, actor_id: userId })
    return json({ ok: true })
  }

  // --- redeploy_all_forged: re-push every forged function's stored source ---
  if (action === 'redeploy_all_forged') {
    if (!managementConfigured()) return json({ error: 'Deploy not configured.' }, 500)
    const { data: fns } = await db.from('forged_functions').select('*')
    const results: Array<{ slug: string; ok: boolean; status?: number; error?: string | null }> = []
    for (const row of fns ?? []) {
      const dep = await deployFunction({ slug: row.slug, name: row.name, source: row.source, verifyJwt: false })
      await db
        .from('forged_functions')
        .update(
          dep.ok
            ? { status: 'deployed', deploy_error: null, updated_at: new Date().toISOString() }
            : { status: 'failed', deploy_error: `${dep.status}: ${dep.body}`.slice(0, 1000) },
        )
        .eq('id', row.id)
      results.push({ slug: row.slug, ok: dep.ok, status: dep.status, error: dep.ok ? null : dep.body.slice(0, 300) })
    }
    const okCount = results.filter((r) => r.ok).length
    await db.from('activity_log').insert({
      type: 'forge.redeploy_all',
      summary: `Redeployed ${okCount}/${results.length} forged functions`,
      detail: { results },
      actor_id: userId,
    })
    return json({ ok: true, results })
  }

  // --- deploy_core: redeploy the app's own repo functions from caller-supplied
  // source (bundled into the admin UI at build time). Slug allow-listed so this
  // can only (re)deploy the known core functions, never arbitrary ones. No lint:
  // core functions legitimately use Deno.env + the service role. ---
  if (action === 'deploy_core') {
    if (!managementConfigured()) return json({ error: 'Deploy not configured.' }, 500)
    const fns = Array.isArray(body.functions) ? (body.functions as Array<Record<string, unknown>>) : []
    if (!fns.length) return json({ error: 'No functions provided.' }, 400)
    const results: Array<{ slug: string; ok: boolean; status?: number; error?: string | null }> = []
    for (const fn of fns) {
      const slug = String(fn?.slug ?? '').trim()
      if (!CORE_SLUGS.has(slug)) {
        results.push({ slug, ok: false, error: 'not an allowed core function' })
        continue
      }
      const files = (Array.isArray(fn?.files) ? fn.files : []).filter(
        (f: unknown): f is { name: string; content: string } =>
          Boolean(f) && typeof (f as { name?: unknown }).name === 'string' && typeof (f as { content?: unknown }).content === 'string',
      )
      if (!files.length) {
        results.push({ slug, ok: false, error: 'no files' })
        continue
      }
      const entrypointPath = String(fn?.entrypoint_path ?? `functions/${slug}/index.ts`)
      const verifyJwt = Boolean(fn?.verify_jwt)
      const dep = await deployFunction({ slug, name: slug, files, entrypointPath, verifyJwt })
      results.push({ slug, ok: dep.ok, status: dep.status, error: dep.ok ? null : dep.body.slice(0, 300) })
    }
    const okCount = results.filter((r) => r.ok).length
    await db.from('activity_log').insert({
      type: 'forge.deploy_core',
      summary: `Deployed ${okCount}/${results.length} core functions`,
      detail: { results },
      actor_id: userId,
    })
    return json({ ok: true, results })
  }

  // --- delete: undeploy + remove tool + remove row ---
  if (action === 'delete') {
    const id = String(body.id ?? '')
    const { data: row } = await db.from('forged_functions').select('*').eq('id', id).maybeSingle()
    if (!row) return json({ error: 'Unknown function.' }, 404)
    const del = await deleteFunction(row.slug)
    if (row.tool_id) await db.from('tools').delete().eq('id', row.tool_id)
    await db.from('forged_functions').delete().eq('id', id)
    await db.from('activity_log').insert({ type: 'forge.deleted', summary: `Deleted forged function "${row.slug}"`, detail: { slug: row.slug, undeployed: del.ok }, actor_id: userId })
    return json({ ok: true, undeployed: del.ok })
  }

  return json({ error: `Unknown action: ${action}` }, 400)
})
