// deno test — the pure IMAP / RFC822 parsing used by the email-poll function.
// Socket/IMAP-framing is in the function; this covers the parsing that turns a
// raw message into the normalized inbox shape.
import { assertEquals, assertStringIncludes } from 'jsr:@std/assert@1'
import {
  decodeMimeWords,
  decodeQuotedPrintable,
  extractTextBody,
  parseAddress,
  parseEmailMessage,
  parseFetchUid,
  parseHeaders,
  parseSearchUids,
  splitHeaderBody,
  stripHtml,
} from '../_shared/imap.ts'

Deno.test('parseSearchUids: extracts uids, tolerates junk', () => {
  assertEquals(parseSearchUids('* SEARCH 2 3 5'), [2, 3, 5])
  assertEquals(parseSearchUids('* SEARCH'), [])
  assertEquals(parseSearchUids('a1 OK SEARCH completed'), [])
  assertEquals(parseSearchUids('* SEARCH 10\r\n* SEARCH 11 12'), [10, 11, 12])
})

Deno.test('parseFetchUid: pulls UID from a FETCH line', () => {
  assertEquals(parseFetchUid('* 3 FETCH (UID 42 BODY[] {123}'), 42)
  assertEquals(parseFetchUid('* 1 FETCH (FLAGS (\\Seen) UID 7)'), 7)
  assertEquals(parseFetchUid('* 1 FETCH (FLAGS (\\Seen))'), null)
})

Deno.test('splitHeaderBody + parseHeaders: folded headers', () => {
  const raw = 'Subject: hello\r\n world\r\nFrom: a@b.com\r\n\r\nbody here'
  const { header, body } = splitHeaderBody(raw)
  assertEquals(body, 'body here')
  const h = parseHeaders(header)
  assertEquals(h.get('subject'), 'hello world') // unfolded
  assertEquals(h.get('from'), 'a@b.com')
})

Deno.test('parseAddress: name + angle-addr and bare', () => {
  assertEquals(parseAddress('Jane Doe <jane@x.com>'), { name: 'Jane Doe', address: 'jane@x.com' })
  assertEquals(parseAddress('"Doe, Jane" <jane@x.com>'), { name: 'Doe, Jane', address: 'jane@x.com' })
  assertEquals(parseAddress('bob@y.com'), { name: '', address: 'bob@y.com' })
})

Deno.test('decodeMimeWords: RFC2047 B and Q', () => {
  assertEquals(decodeMimeWords('=?utf-8?B?SGVsbG8gV29ybGQ=?='), 'Hello World')
  assertEquals(decodeMimeWords('=?utf-8?Q?Hello_World?='), 'Hello World')
  assertEquals(decodeMimeWords('plain subject'), 'plain subject')
  // adjacent encoded-words: whitespace between them is dropped
  assertEquals(decodeMimeWords('=?utf-8?B?SGVs?= =?utf-8?B?bG8=?='), 'Hello')
})

Deno.test('decodeQuotedPrintable: soft breaks + =XX', () => {
  assertEquals(decodeQuotedPrintable('Hello=20World'), 'Hello World')
  assertEquals(decodeQuotedPrintable('line one=\r\nline two'), 'line oneline two')
  assertEquals(decodeQuotedPrintable('caf=C3=A9'), 'café')
})

Deno.test('stripHtml: tags, scripts, entities', () => {
  assertEquals(stripHtml('<p>Hi <b>there</b></p>'), 'Hi there')
  assertEquals(stripHtml('a &amp; b &lt;c&gt;'), 'a & b <c>')
  assertStringIncludes(stripHtml('<style>x{}</style><div>keep</div>'), 'keep')
})

Deno.test('extractTextBody: plain single-part', () => {
  const raw = 'Content-Type: text/plain; charset=utf-8\r\n\r\nJust text.'
  assertEquals(extractTextBody(raw), 'Just text.')
})

Deno.test('extractTextBody: multipart/alternative prefers text/plain', () => {
  const boundary = 'BOUND123'
  const raw = [
    'Content-Type: multipart/alternative; boundary="BOUND123"',
    '',
    'preamble ignored',
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    'plain body wins',
    `--${boundary}`,
    'Content-Type: text/html; charset=utf-8',
    '',
    '<p>html body</p>',
    `--${boundary}--`,
    '',
  ].join('\r\n')
  assertEquals(extractTextBody(raw), 'plain body wins')
})

Deno.test('extractTextBody: base64 text/plain part', () => {
  const boundary = 'B'
  const b64 = btoa('decoded base64 body')
  const raw = [
    'Content-Type: multipart/mixed; boundary="B"',
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    b64,
    `--${boundary}--`,
    '',
  ].join('\r\n')
  assertEquals(extractTextBody(raw), 'decoded base64 body')
})

Deno.test('extractTextBody: html-only falls back to stripped text', () => {
  const raw = 'Content-Type: text/html; charset=utf-8\r\n\r\n<h1>Title</h1><p>Body</p>'
  assertStringIncludes(extractTextBody(raw), 'Title')
  assertStringIncludes(extractTextBody(raw), 'Body')
})

Deno.test('extractTextBody: 8-bit utf-8 body (latin1-preserved) re-decodes', () => {
  // 'café' as UTF-8 bytes 0x63 0x61 0x66 0xC3 0xA9, carried through as latin1.
  const raw = 'Content-Type: text/plain; charset=utf-8\r\n\r\ncafÃ©'
  assertEquals(extractTextBody(raw), 'café')
})

Deno.test('parseEmailMessage: end-to-end normalization', () => {
  const raw = [
    'From: =?utf-8?Q?Jane_Doe?= <jane@example.com>',
    'To: monitoring@unearthcampaigns.com',
    'Subject: =?utf-8?B?SGVsbG8gV29ybGQ=?=',
    'Message-ID: <abc123@example.com>',
    'Date: Wed, 29 Jul 2026 10:00:00 +0000',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'The body text.',
  ].join('\r\n')
  const p = parseEmailMessage(raw)
  assertEquals(p.from, 'jane@example.com')
  assertEquals(p.fromName, 'Jane Doe')
  assertEquals(p.subject, 'Hello World')
  assertEquals(p.messageId, 'abc123@example.com')
  assertEquals(p.text, 'The body text.')
})
