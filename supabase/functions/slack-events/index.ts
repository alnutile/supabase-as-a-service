// Supabase Edge Function: `slack-events` (PUBLIC — verify_jwt=false).
//
// The Slack side of "rooms bound to collections": a Slack app subscribes its
// Events API to this URL; when someone @mentions the bot in a channel, we look
// up that channel's binding (slack_channel_bindings → collections + optional
// agent), run the same agent loop as the webhook function (collections context,
// guardrails fail-closed, tools only when the binding opts in), and post the
// answer back into the Slack thread via chat.postMessage.
//
// Slack protocol requirements handled here, in order:
//   1. HMAC signature verification (signing secret from Vault) + replay window.
//   2. `url_verification` handshake (echo the challenge).
//   3. Dedupe on Slack's event_id — Slack redelivers on slow acks/non-2xx.
//   4. Ack within 3 seconds: respond 200 immediately and do the model work in
//      the background via EdgeRuntime.waitUntil.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4'
import { resolveModel } from '../_shared/models.ts'
import { runGuardrails } from '../_shared/guardrails.ts'
import { runBuiltin } from '../_shared/builtins.ts'
import { expandMcpTools, runMcpTool, type McpRouter } from '../_shared/mcp.ts'
import { recordUsage } from '../_shared/usage.ts'
import { RunRecorder } from '../_shared/run_recorder.ts'
import { loadCollectionsContext } from '../_shared/collections.ts'
import { currentTimeSection, resolveWorkspaceTimezone } from '../_shared/timezone.ts'
import { runHttpTool } from '../_shared/http_tool.ts'
import {
  buildParticipationSystem,
  fetchSlackTranscript,
  fetchSlackUserNames,
  formatTranscript,
  mentionsBot,
  parseParticipationVerdict,
  passesAmbientPrefilter,
  postSlackMessage,
  shouldSkipEvent,
  slackTextToPlain,
  stripBotMention,
  toMrkdwn,
  verifySlackSignature,
  type SlackEvent,
} from '../_shared/slack.ts'
import {
  assistantToolCallMsg,
  orApiKey,
  orComplete,
  parseToolArgs,
  reasoningParam,
  systemMsg,
  toolResultMsg,
  toORTool,
  WEB_SEARCH_TOOL,
  type ORMessage,
  type ORTool,
} from '../_shared/openrouter.ts'

// How many model→tool→model round-trips one reply may take. A Slack @mention
// comes from an authenticated workspace member (not an anonymous webhook
// caller), so the loop gets chat-sized runway — a real "search → read →
// cross-reference → write" task needs more than a handful, and hitting the cap
// ends the reply mid-work. Kept bounded so a misbehaving loop can't run away;
// the wall-clock guard below finalizes the run before the platform kills it.
const MAX_TOOL_TURNS = 16

// Per-completion output budget. Slack truncates a posted message at
// SLACK_TEXT_LIMIT (12000 chars) anyway, so this sits above the delivery cap
// without matching chat's 16000 (which would only be wasted here).
const MAX_TOKENS = 8000

// Stop the tool loop this many ms in, before the platform wall-clock limit
// (150s free / 400s paid) would kill the worker. Unlike chat (which streams and
// persists incrementally) the Slack bot posts only once, at the end — so a run
// killed mid-loop would post NOTHING. Instead we break early and post whatever
// the model has produced so far. Override with SLACK_MAX_WALL_MS on paid plans.
const WALL_CLOCK_MS = Number(Deno.env.get('SLACK_MAX_WALL_MS') ?? 130_000)

interface ToolRow {
  id: string
  name: string
  description: string
  input_schema: Record<string, unknown>
  kind: string
  config: { url?: string; method?: string; headers?: Record<string, string> }
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

// Same shape as the webhook function's loader: resolve an agent's tool_ids to
// callable tools (http / builtin / mcp / web).
// deno-lint-ignore no-explicit-any
async function loadAgentTools(db: any, restrictIds: string[]) {
  const tools: ORTool[] = []
  const httpTools = new Map<string, ToolRow>()
  const builtins = new Set<string>()
  const mcpRows: ToolRow[] = []
  let mcpRouter: McpRouter = new Map()
  let webEnabled = false
  if (!restrictIds.length) return { tools, httpTools, builtins, mcpRouter, webEnabled }
  const { data } = await db.from('tools').select('*').eq('is_active', true)
  for (const t of (data ?? []) as ToolRow[]) {
    if (!restrictIds.includes(t.id)) continue
    if (t.kind === 'web') webEnabled = true
    else if (t.kind === 'builtin' && t.name) {
      tools.push(toORTool(t.name, t.description, t.input_schema))
      builtins.add(t.name)
    } else if (t.kind === 'http' && t.name) {
      tools.push(toORTool(t.name, t.description, t.input_schema))
      httpTools.set(t.name, t)
    } else if (t.kind === 'mcp') {
      mcpRows.push(t)
    }
  }
  const mcp = await expandMcpTools(db, mcpRows)
  for (const mt of mcp.tools) tools.push(mt)
  mcpRouter = mcp.router
  return { tools, httpTools, builtins, mcpRouter, webEnabled }
}

interface SlackSecrets {
  bot_token: string
  signing_secret: string
  bot_user_id: string | null
}

interface Binding {
  id: string
  channel_id: string
  channel_name: string
  collection_ids: string[]
  agent_id: string | null
  owner_id: string
  allow_tools: boolean
  is_active: boolean
  mode: string
  participation_prompt: string
  gate_model: string | null
  capture_messages: boolean
}

// Entry after the 200 ack (EdgeRuntime.waitUntil). Dispatches on event type:
// an @mention always replies (with a "not linked" nudge if the channel has no
// binding); a plain channel message only does anything in an AMBIENT channel,
// where it's captured to the inbox and a cheap model decides whether to chime in.
// deno-lint-ignore no-explicit-any
async function processEvent(db: any, secrets: SlackSecrets, event: SlackEvent, eventRowId: string | null) {
  const channel = event.channel!
  const setStatus = async (patch: Record<string, unknown>) => {
    if (eventRowId) await db.from('slack_events').update(patch).eq('id', eventRowId)
  }

  try {
    const { data: binding } = await db
      .from('slack_channel_bindings')
      .select('*')
      .eq('channel_id', channel)
      .eq('is_active', true)
      .maybeSingle() as { data: Binding | null }

    if (event.type === 'app_mention') {
      if (!binding) {
        await postSlackMessage(
          secrets.bot_token,
          channel,
          'This channel isn’t linked to the workspace yet — an admin can bind it to a collection in Settings → Slack.',
          event.thread_ts ?? event.ts ?? null,
        )
        await setStatus({ status: 'skipped', error: 'no binding for channel' })
        return
      }
      const text = slackTextToPlain(stripBotMention(event.text ?? '', secrets.bot_user_id))
      await setStatus({ text })
      await respondToMessage(db, secrets, binding, event, eventRowId, text)
      return
    }

    // Plain channel message. Only ambient channels react to these.
    if (!binding || binding.mode !== 'ambient') {
      await setStatus({ status: 'skipped', error: 'not an ambient channel' })
      return
    }
    const text = slackTextToPlain(event.text ?? '')
    await setStatus({ text })

    // Absorb every message into the unified inbox first (even if the bot stays
    // silent) so channel traffic is searchable/filable and drives listeners.
    if (binding.capture_messages) await captureToInbox(db, binding, event, text)

    // A message that @mentions the bot is also delivered as its own app_mention
    // event — let that path reply, so we don't answer twice.
    if (mentionsBot(event.text ?? '', secrets.bot_user_id)) {
      await setStatus({ status: 'skipped', error: 'mention handled by app_mention' })
      return
    }
    // Cheap heuristic gate before spending a model call.
    if (!passesAmbientPrefilter(text)) {
      await setStatus({ status: 'skipped', error: 'prefiltered' })
      return
    }
    // Cheap model decides whether to chime in, guided by the channel prompt.
    const verdict = await decideParticipation(db, secrets, binding, event, text)
    if (!verdict.respond) {
      await setStatus({ status: 'skipped', error: `stayed silent: ${verdict.reason}`.slice(0, 300) })
      return
    }
    await respondToMessage(db, secrets, binding, event, eventRowId, text)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'processing failed'
    await setStatus({ status: 'error', error: message })
  }
}

// Capture a Slack channel message into the unified inbox (source='slack'),
// deduped per (channel, ts). Best-effort — never blocks the reply path.
// deno-lint-ignore no-explicit-any
async function captureToInbox(db: any, binding: Binding, event: SlackEvent, text: string) {
  try {
    await db.from('inbox_messages').insert({
      owner_id: binding.owner_id,
      source: 'slack',
      external_id: `${event.channel}:${event.ts}`,
      from_name: '',
      from_address: event.user ?? '',
      subject: '',
      body_text: text.slice(0, 50_000),
      visibility: 'workspace',
      raw: {
        channel: event.channel,
        channel_name: binding.channel_name,
        ts: event.ts,
        thread_ts: event.thread_ts ?? null,
        slack_user: event.user,
      },
    })
  } catch {
    // Duplicate re-delivery (unique on source+external_id) or transient error.
  }
}

// The "should the bot chime in?" gate: one cheap model call (the binding's
// gate_model override, else the utility profile) that returns a JSON verdict.
// Fails SILENT — for ambient replies a false positive (spam) is worse than a miss.
// deno-lint-ignore no-explicit-any
async function decideParticipation(
  db: any,
  secrets: SlackSecrets,
  binding: Binding,
  event: SlackEvent,
  text: string,
): Promise<{ respond: boolean; reason: string }> {
  try {
    const transcriptMsgs = await fetchSlackTranscript(secrets.bot_token, event.channel!, event.thread_ts ?? null, 8)
    const names = await fetchSlackUserNames(
      secrets.bot_token,
      [...(event.user ? [event.user] : []), ...transcriptMsgs.map((m) => m.user).filter((u): u is string => Boolean(u))],
    )
    const asker = names.get(event.user ?? '') ?? event.user ?? 'someone'
    const transcript = formatTranscript(transcriptMsgs, names, event.ts)
    const gateModel = binding.gate_model?.trim() || (await resolveModel(db, 'utility'))
    const userContent =
      (transcript ? `Recent messages in this channel:\n${transcript}\n\n` : '') + `New message from ${asker}:\n${text}`
    const out = await orComplete({
      model: gateModel,
      maxTokens: 200,
      messages: [systemMsg(buildParticipationSystem(binding.participation_prompt)), { role: 'user', content: userContent }],
    })
    await recordUsage(db, { context: 'slack', model: gateModel, actorId: binding.owner_id, usage: out.usage })
    return parseParticipationVerdict(out.content)
  } catch {
    return { respond: false, reason: 'gate error' }
  }
}

// The model run + Slack reply for a message we've decided to answer (an @mention,
// or an ambient message the gate approved). Executed after the 200 ack.
// deno-lint-ignore no-explicit-any
async function respondToMessage(
  db: any,
  secrets: SlackSecrets,
  binding: Binding,
  event: SlackEvent,
  eventRowId: string | null,
  text: string,
) {
  const channel = event.channel!
  const threadTs = event.thread_ts ?? event.ts ?? null
  const setStatus = async (patch: Record<string, unknown>) => {
    if (eventRowId) await db.from('slack_events').update(patch).eq('id', eventRowId)
  }
  // Hoisted so the catch can finalize the run trace on failure.
  let rec: RunRecorder | null = null

  try {
    // Guardrails: Slack messages are multi-user, semi-trusted input evaluated
    // like webhook payloads — and like webhooks this unattended path fails
    // CLOSED (an evaluator error blocks the run).
    const guard = await runGuardrails(db, 'webhook', text, binding.owner_id)
    if (guard.ok === false) {
      const blocked = 'error' in guard || guard.blocked
      if (blocked) {
        const reason = 'error' in guard
          ? `Guardrail evaluator error: ${guard.error}`
          : guard.violations.map((v) => `${v.name}: ${v.reason}`).join('; ')
        await setStatus({ status: 'blocked', error: reason })
        await db.from('activity_log').insert({
          type: 'guardrail.blocked',
          summary: `Blocked a Slack mention in #${binding.channel_name || channel}`,
          detail: { slack_event_id: eventRowId, reason },
          actor_id: binding.owner_id,
        })
        await postSlackMessage(secrets.bot_token, channel, '⛔ That request was blocked by a workspace guardrail.', threadTs)
        return
      }
      await db.from('activity_log').insert({
        type: 'guardrail.flagged',
        summary: `Flagged a Slack mention in #${binding.channel_name || channel}`,
        detail: { slack_event_id: eventRowId, violations: guard.violations },
        actor_id: binding.owner_id,
      })
    }

    const MODEL = await resolveModel(db, 'orchestrator')

    // Resolve what runs: the bound agent (prompt + tools) or a plain assistant.
    let systemPrompt =
      `You are the team's assistant, replying inside the Slack channel #${binding.channel_name || channel}. ` +
      'Answer using the collection context below when relevant, be concise, and format for Slack (short paragraphs, bullets).'
    let collectionIds = [...(binding.collection_ids ?? [])]
    let tools: ORTool[] = []
    let httpTools = new Map<string, ToolRow>()
    let builtins = new Set<string>()
    let mcpRouter: McpRouter = new Map()
    let webEnabled = false
    if (binding.agent_id) {
      const { data: agent } = await db
        .from('agents')
        .select('instructions, tool_ids, collection_ids')
        .eq('id', binding.agent_id)
        .maybeSingle()
      if (agent) {
        systemPrompt = agent.instructions || systemPrompt
        collectionIds = [...new Set([...collectionIds, ...((agent.collection_ids as string[] | null) ?? [])])]
        // Deterministic rule, mirroring webhooks: the agent runs toolless
        // unless the binding opts in with allow_tools.
        if (binding.allow_tools) {
          const loaded = await loadAgentTools(db, (agent.tool_ids as string[] | null) ?? [])
          tools = loaded.tools
          httpTools = loaded.httpTools
          builtins = loaded.builtins
          mcpRouter = loaded.mcpRouter
          webEnabled = loaded.webEnabled
        }
      }
    }

    const collCtx = await loadCollectionsContext(db, collectionIds, binding.owner_id, MODEL)
    if (collCtx) systemPrompt += `\n\n---\n\n${collCtx}`

    // Prepend the workspace-local date/time so the bot answers "what's today?"
    // style questions in the team's timezone rather than UTC.
    const timezone = await resolveWorkspaceTimezone(db)
    systemPrompt = `${currentTimeSection(timezone, new Date())}\n\n---\n\n${systemPrompt}`

    // Conversational context: the thread's replies (or the channel's last few
    // messages) plus who is asking, so follow-up mentions read naturally.
    const transcriptMsgs = await fetchSlackTranscript(secrets.bot_token, channel, event.thread_ts ?? null)
    const userIds = [
      ...(event.user ? [event.user] : []),
      ...transcriptMsgs.map((m) => m.user).filter((u): u is string => Boolean(u)),
    ]
    const names = await fetchSlackUserNames(secrets.bot_token, userIds)
    const asker = names.get(event.user ?? '') ?? event.user ?? 'someone'
    const transcript = formatTranscript(transcriptMsgs, names, event.ts)
    const userContent = transcript
      ? `Recent messages in this ${event.thread_ts ? 'thread' : 'channel'}:\n${transcript}\n\n${asker} now asks:\n${text}`
      : `${asker} asks:\n${text}`

    if (webEnabled) tools.push(WEB_SEARCH_TOOL)
    const reasoning = reasoningParam()
    const messages: ORMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent },
    ]
    rec = await RunRecorder.open(db, {
      agentId: binding.agent_id,
      ownerId: binding.owner_id,
      surface: 'slack',
      triggerRef: { slack_event_id: eventRowId, channel },
      model: MODEL,
      input: userContent,
    })
    let result = ''
    const startedAt = Date.now()
    for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
      // Finalize before the platform wall-clock limit kills the worker: post
      // what we have rather than dropping the reply entirely mid-loop.
      if (Date.now() - startedAt > WALL_CLOCK_MS) {
        if (!result) result = 'This took longer than I could spend on it — try narrowing the request.'
        break
      }
      const out = await orComplete({
        model: MODEL,
        messages,
        tools: tools.length ? tools : undefined,
        reasoning,
        maxTokens: MAX_TOKENS,
      })
      result = out.content || result
      await recordUsage(db, {
        context: 'slack',
        model: MODEL,
        actorId: binding.owner_id,
        agentId: binding.agent_id,
        usage: out.usage,
      })
      await rec?.modelTurn(out.content, out.usage)

      if (out.toolCalls.length) {
        messages.push(assistantToolCallMsg(out.content, out.toolCalls))
        for (const call of out.toolCalls) {
          const name = call.function.name
          const input = parseToolArgs(call.function.arguments)
          const tool = httpTools.get(name)
          let output: string
          const started = Date.now()
          if (tool) output = await runHttpTool(db, tool, input)
          else if (builtins.has(name)) output = await runBuiltin(db, name, input, binding.owner_id)
          else if (mcpRouter.has(name)) output = await runMcpTool(db, mcpRouter, name, input)
          else output = `Unknown tool: ${name}`
          await rec?.toolStep({ name, input, output, durationMs: Date.now() - started })
          messages.push(toolResultMsg(call.id, output))
        }
        continue
      }
      break
    }
    await rec?.finish({ status: 'done', finalOutput: result })

    const reply = toMrkdwn(result) || 'I couldn’t come up with a reply for that.'
    const posted = await postSlackMessage(secrets.bot_token, channel, reply, threadTs)
    if (!posted.ok) throw new Error(`chat.postMessage failed: ${posted.error ?? 'unknown'}`)

    await setStatus({ status: 'ok', result })
    await db.from('activity_log').insert({
      type: 'slack.reply',
      summary: `Replied in #${binding.channel_name || channel}${event.type === 'app_mention' ? '' : ' (ambient)'}`,
      detail: { slack_event_id: eventRowId, asked_by: asker, agent_id: binding.agent_id, ambient: event.type !== 'app_mention' },
      actor_id: binding.owner_id,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'processing failed'
    await rec?.finish({ status: 'error', error: message })
    await setStatus({ status: 'error', error: message })
  }
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return json({ error: 'Use POST' }, 405)

  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!supabaseUrl || !serviceKey || !orApiKey()) return json({ error: 'Server not configured' }, 500)
  const db = createClient(supabaseUrl, serviceKey)

  // Raw body FIRST — the signature is computed over the exact bytes.
  const raw = await req.text()

  const { data: secretRows } = await db.rpc('read_slack_secrets')
  const secrets = (secretRows?.[0] ?? null) as SlackSecrets | null
  if (!secrets?.bot_token || !secrets?.signing_secret) {
    return json({ ok: false, error: 'Slack is not configured' }, 200)
  }

  const valid = await verifySlackSignature({
    signingSecret: secrets.signing_secret,
    body: raw,
    timestamp: req.headers.get('x-slack-request-timestamp'),
    signature: req.headers.get('x-slack-signature'),
  })
  if (!valid) return json({ error: 'Bad signature' }, 401)

  // deno-lint-ignore no-explicit-any
  let body: any
  try {
    body = JSON.parse(raw)
  } catch {
    return json({ error: 'Bad JSON' }, 400)
  }

  // One-time Events API handshake (Slack signs this request too).
  if (body?.type === 'url_verification') return json({ challenge: body.challenge })
  if (body?.type !== 'event_callback') return json({ ok: true, ignored: true })

  const event = (body.event ?? {}) as SlackEvent
  // @mentions always; plain channel messages too (the ambient path decides what
  // to do with them). Threaded broadcasts and other message subtypes are dropped
  // by shouldSkipEvent below.
  if (event.type !== 'app_mention' && event.type !== 'message') return json({ ok: true, ignored: true })
  const skip = shouldSkipEvent(event)
  if (skip) return json({ ok: true, ignored: true, reason: skip })

  // Learn the bot's own user id from the event authorizations on first contact
  // (used to strip self-mentions from message text).
  if (!secrets.bot_user_id) {
    const auth = (body.authorizations ?? []).find((a: { is_bot?: boolean }) => a?.is_bot)
    if (auth?.user_id) {
      secrets.bot_user_id = auth.user_id
      await db.from('slack_integration').update({ bot_user_id: auth.user_id }).eq('singleton', true)
    }
  }

  // Dedupe on event_id: Slack retries on slow acks, and the retry must not
  // trigger a second model run + reply. The unique insert is the gate.
  const eventId = String(body.event_id ?? '')
  if (!eventId) return json({ ok: true, ignored: true, reason: 'no event_id' })
  const { data: row, error: insertErr } = await db
    .from('slack_events')
    .insert({
      event_id: eventId,
      channel_id: event.channel,
      slack_user_id: event.user,
      kind: event.type,
      text: event.text,
    })
    .select('id')
    .maybeSingle()
  if (insertErr) return json({ ok: true, duplicate: true })

  // Ack now; think later. Slack requires a response within 3 seconds — the
  // model run happens in the background and replies via chat.postMessage.
  const task = processEvent(db, secrets, event, row?.id ?? null)
  // deno-lint-ignore no-explicit-any
  const er = (globalThis as any).EdgeRuntime
  if (er && typeof er.waitUntil === 'function') er.waitUntil(task)
  else await task

  return json({ ok: true })
})
