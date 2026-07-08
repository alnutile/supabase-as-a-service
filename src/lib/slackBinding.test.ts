import { describe, expect, it } from 'vitest'
import {
  bindingToForm,
  buildSlackBindingPayload,
  CHANNEL_ID_REQUIRED,
  type SlackBindingForm,
} from './slackBinding'

const base: SlackBindingForm = {
  channelId: 'C0123ABCDEF',
  channelName: 'project-acme',
  collectionIds: ['a', 'b'],
  agentId: '',
  allowTools: false,
  ambient: false,
  participationPrompt: '',
  gateModel: '',
  captureMessages: true,
}

describe('buildSlackBindingPayload', () => {
  it('requires a channel id', () => {
    const r = buildSlackBindingPayload({ ...base, channelId: '   ' })
    expect(r).toEqual({ ok: false, error: CHANNEL_ID_REQUIRED })
  })

  it('trims the channel id and de-hashes the channel name', () => {
    const r = buildSlackBindingPayload({ ...base, channelId: ' C1 ', channelName: '#general ' })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.payload.channel_id).toBe('C1')
      expect(r.payload.channel_name).toBe('general')
    }
  })

  it('maps mention mode and empties agent/ambient fields', () => {
    const r = buildSlackBindingPayload(base)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.payload).toEqual({
        channel_id: 'C0123ABCDEF',
        channel_name: 'project-acme',
        collection_ids: ['a', 'b'],
        agent_id: null,
        allow_tools: false,
        mode: 'mention',
        participation_prompt: '',
        gate_model: null,
        capture_messages: true,
      })
    }
  })

  it('keeps ambient fields only when ambient is on', () => {
    const r = buildSlackBindingPayload({
      ...base,
      agentId: 'agent-1',
      allowTools: true,
      ambient: true,
      participationPrompt: '  jump in on billing  ',
      gateModel: '  anthropic/claude-haiku-4.5  ',
      captureMessages: false,
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.payload.mode).toBe('ambient')
      expect(r.payload.agent_id).toBe('agent-1')
      expect(r.payload.allow_tools).toBe(true)
      expect(r.payload.participation_prompt).toBe('jump in on billing')
      expect(r.payload.gate_model).toBe('anthropic/claude-haiku-4.5')
      expect(r.payload.capture_messages).toBe(false)
    }
  })

  it('drops ambient text when ambient is off even if fields are filled', () => {
    const r = buildSlackBindingPayload({
      ...base,
      ambient: false,
      participationPrompt: 'stale',
      gateModel: 'stale/model',
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.payload.participation_prompt).toBe('')
      expect(r.payload.gate_model).toBe(null)
    }
  })

  it('blank gate model in ambient mode is null', () => {
    const r = buildSlackBindingPayload({ ...base, ambient: true, gateModel: '   ' })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.payload.gate_model).toBe(null)
  })
})

describe('bindingToForm', () => {
  it('round-trips a built payload back into a form', () => {
    const built = buildSlackBindingPayload({
      ...base,
      ambient: true,
      participationPrompt: 'help out',
      gateModel: 'x/y',
      agentId: 'agent-9',
      allowTools: true,
      captureMessages: false,
    })
    expect(built.ok).toBe(true)
    if (!built.ok) return
    const form = bindingToForm({ ...built.payload })
    expect(form).toEqual({
      channelId: 'C0123ABCDEF',
      channelName: 'project-acme',
      collectionIds: ['a', 'b'],
      agentId: 'agent-9',
      allowTools: true,
      ambient: true,
      participationPrompt: 'help out',
      gateModel: 'x/y',
      captureMessages: false,
    })
  })

  it('applies defaults for null columns', () => {
    const form = bindingToForm({
      channel_id: 'C9',
      channel_name: null,
      collection_ids: null,
      agent_id: null,
      allow_tools: null,
      mode: null,
      participation_prompt: null,
      gate_model: null,
      capture_messages: null,
    })
    expect(form).toEqual({
      channelId: 'C9',
      channelName: '',
      collectionIds: [],
      agentId: '',
      allowTools: false,
      ambient: false,
      participationPrompt: '',
      gateModel: '',
      captureMessages: true,
    })
  })
})
