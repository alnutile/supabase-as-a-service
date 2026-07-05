// deno test — the slack-events function's pure logic. Signature verification
// is the security gate for the public endpoint (there's no URL token), so it
// gets the closest coverage; the text transforms shape what the model sees and
// what Slack renders.
import { assertEquals } from 'jsr:@std/assert@1'
import {
  computeSlackSignature,
  formatTranscript,
  shouldSkipEvent,
  slackTextToPlain,
  stripBotMention,
  timingSafeEqual,
  toMrkdwn,
  verifySlackSignature,
} from '../_shared/slack.ts'

const SECRET = '8f742231b10e8888abcd99yyyzzz85a5'
const BODY = '{"type":"event_callback","event":{"type":"app_mention"}}'

Deno.test('signature round-trip verifies', async () => {
  const ts = '1531420618'
  const sig = await computeSlackSignature(SECRET, ts, BODY)
  assertEquals(sig.startsWith('v0='), true)
  assertEquals(
    await verifySlackSignature({
      signingSecret: SECRET,
      body: BODY,
      timestamp: ts,
      signature: sig,
      nowSeconds: 1531420618 + 10,
    }),
    true,
  )
})

Deno.test('tampered body, wrong secret, or altered signature fail', async () => {
  const ts = '1531420618'
  const sig = await computeSlackSignature(SECRET, ts, BODY)
  const at = (args: Partial<Parameters<typeof verifySlackSignature>[0]>) =>
    verifySlackSignature({
      signingSecret: SECRET,
      body: BODY,
      timestamp: ts,
      signature: sig,
      nowSeconds: 1531420618,
      ...args,
    })
  assertEquals(await at({ body: BODY + ' ' }), false)
  assertEquals(await at({ signingSecret: 'other-secret' }), false)
  assertEquals(await at({ signature: sig.slice(0, -1) + '0' }), false)
  assertEquals(await at({ signature: null }), false)
  assertEquals(await at({ timestamp: null }), false)
})

Deno.test('stale or non-numeric timestamps fail (replay window)', async () => {
  const ts = '1531420618'
  const sig = await computeSlackSignature(SECRET, ts, BODY)
  const base = { signingSecret: SECRET, body: BODY, signature: sig }
  assertEquals(
    await verifySlackSignature({ ...base, timestamp: ts, nowSeconds: 1531420618 + 301 }),
    false,
  )
  assertEquals(
    await verifySlackSignature({ ...base, timestamp: 'not-a-number', nowSeconds: 1531420618 }),
    false,
  )
})

Deno.test('timingSafeEqual compares correctly', () => {
  assertEquals(timingSafeEqual('v0=abc', 'v0=abc'), true)
  assertEquals(timingSafeEqual('v0=abc', 'v0=abd'), false)
  assertEquals(timingSafeEqual('short', 'longer-string'), false)
})

Deno.test('stripBotMention removes the bot, keeps other mentions', () => {
  assertEquals(stripBotMention('<@U0BOT> summarize the doc', 'U0BOT'), 'summarize the doc')
  assertEquals(
    stripBotMention('hey <@U0BOT> ping <@U0HUMAN> about this', 'U0BOT'),
    'hey ping <@U0HUMAN> about this',
  )
  // Unknown bot id: only a LEADING mention is stripped.
  assertEquals(stripBotMention('<@U0BOT> do the thing', null), 'do the thing')
  assertEquals(stripBotMention('ask <@U0HUMAN> first', null), 'ask <@U0HUMAN> first')
})

Deno.test('slackTextToPlain decodes mentions, links, and entities', () => {
  assertEquals(slackTextToPlain('see <https://a.io/x|the doc> &amp; <#C1|general>'), 'see the doc (https://a.io/x) & #general')
  assertEquals(slackTextToPlain('<@U1|jo> said 1 &lt; 2'), '@jo said 1 < 2')
  assertEquals(slackTextToPlain('go to <https://b.io>'), 'go to https://b.io')
})

Deno.test('toMrkdwn converts markdown to Slack formatting', () => {
  assertEquals(toMrkdwn('## Plan\n**bold** and [site](https://x.io)\n- one\n- two'),
    '*Plan*\n*bold* and <https://x.io|site>\n• one\n• two')
  // fenced code passes through untouched
  const code = '```\n**not bold** - not a bullet\n```'
  assertEquals(toMrkdwn(code), code)
})

Deno.test('shouldSkipEvent blocks bots, subtypes, and empty messages', () => {
  const base = { type: 'app_mention', user: 'U1', channel: 'C1', text: 'hi', ts: '1' }
  assertEquals(shouldSkipEvent(base), null)
  assertEquals(shouldSkipEvent({ ...base, bot_id: 'B1' }), 'bot message')
  assertEquals(shouldSkipEvent({ ...base, subtype: 'message_changed' }), 'subtype message_changed')
  assertEquals(shouldSkipEvent({ ...base, text: '  ' }), 'empty text')
  assertEquals(shouldSkipEvent({ ...base, user: undefined }), 'no user')
})

Deno.test('formatTranscript names speakers and excludes the trigger message', () => {
  const names = new Map([['U1', 'Ada'], ['U2', 'Grace']])
  const msgs = [
    { user: 'U1', text: 'shipping today?', ts: '1' },
    { bot_id: 'B1', text: 'Yes — 3pm.', ts: '2' },
    { user: 'U2', text: '<@U0BOT> confirm with the client', ts: '3' },
  ]
  assertEquals(
    formatTranscript(msgs, names, '3'),
    'Ada: shipping today?\nassistant (you): Yes — 3pm.',
  )
  // Unknown users fall back to their id; empty messages are dropped.
  assertEquals(formatTranscript([{ user: 'U9', text: 'hi', ts: '4' }, { user: 'U9', text: ' ', ts: '5' }], names), 'U9: hi')
})
