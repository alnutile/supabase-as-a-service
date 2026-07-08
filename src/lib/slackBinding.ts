// Pure Slack channel-binding form logic — no Supabase/side-effect imports so it
// can be unit-tested in isolation. The SlackCard component (settings/cards.tsx)
// uses this for both creating a new binding and editing an existing one, so the
// create/edit paths stay in lockstep. Mirrors the pattern in linkEdit.ts.

export type SlackBindingForm = {
  channelId: string
  channelName: string
  collectionIds: string[]
  agentId: string
  allowTools: boolean
  ambient: boolean
  participationPrompt: string
  gateModel: string
  captureMessages: boolean
}

// The columns written to `slack_channel_bindings` (owner_id is added by the
// caller on insert; it never changes on edit).
export type SlackBindingPayload = {
  channel_id: string
  channel_name: string
  collection_ids: string[]
  agent_id: string | null
  allow_tools: boolean
  mode: 'ambient' | 'mention'
  participation_prompt: string
  gate_model: string | null
  capture_messages: boolean
}

export type SlackBindingResult =
  | { ok: true; payload: SlackBindingPayload }
  | { ok: false; error: string }

export const CHANNEL_ID_REQUIRED =
  'The Slack channel ID (C…) is required — channel details → About → Channel ID.'

/**
 * Validate + normalize a binding form into a DB payload. The channel ID is
 * required; the channel name is trimmed and de-hashed ("#foo" → "foo"); the
 * ambient-only fields are cleared when ambient mode is off so a paused/edited
 * binding can't keep a stale participation prompt or gate model.
 */
export function buildSlackBindingPayload(form: SlackBindingForm): SlackBindingResult {
  const channel_id = form.channelId.trim()
  if (!channel_id) return { ok: false, error: CHANNEL_ID_REQUIRED }
  const ambient = form.ambient
  return {
    ok: true,
    payload: {
      channel_id,
      channel_name: form.channelName.trim().replace(/^#/, ''),
      collection_ids: form.collectionIds,
      agent_id: form.agentId || null,
      allow_tools: form.allowTools,
      mode: ambient ? 'ambient' : 'mention',
      participation_prompt: ambient ? form.participationPrompt.trim() : '',
      gate_model: ambient && form.gateModel.trim() ? form.gateModel.trim() : null,
      capture_messages: form.captureMessages,
    },
  }
}

// A `slack_channel_bindings` row (or the subset of it the edit form reads).
export type EditableSlackBinding = {
  channel_id: string
  channel_name: string | null
  collection_ids: string[] | null
  agent_id: string | null
  allow_tools: boolean | null
  mode: string | null
  participation_prompt: string | null
  gate_model: string | null
  capture_messages: boolean | null
}

/** Hydrate the edit form from an existing binding row (inverse of build). */
export function bindingToForm(b: EditableSlackBinding): SlackBindingForm {
  const ambient = b.mode === 'ambient'
  return {
    channelId: b.channel_id,
    channelName: b.channel_name ?? '',
    collectionIds: b.collection_ids ?? [],
    agentId: b.agent_id ?? '',
    allowTools: Boolean(b.allow_tools),
    ambient,
    participationPrompt: b.participation_prompt ?? '',
    gateModel: b.gate_model ?? '',
    captureMessages: b.capture_messages ?? true,
  }
}
