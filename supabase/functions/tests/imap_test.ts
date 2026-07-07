// deno test — IMAP wire parsing for the imap-poll connector. We can't reach a
// real server in CI, so we exercise the pure parsers and the reader/response
// drivers over canned byte streams (literals included) — the parts most likely
// to break silently on real mail.
import { assertEquals } from 'jsr:@std/assert@1'
import {
  ImapReader,
  parseSearchUids,
  parseSelect,
  readFetchMessages,
  readLineResponse,
  selectNewUids,
  type ByteSource,
} from '../_shared/imap.ts'

// A ByteSource backed by a fixed buffer, handing out at most `chunk` bytes per
// read so we also cover the reader stitching data across multiple reads.
function source(bytes: Uint8Array, chunk = 7): ByteSource {
  let pos = 0
  return {
    read(p: Uint8Array): Promise<number | null> {
      if (pos >= bytes.length) return Promise.resolve(null)
      const n = Math.min(chunk, bytes.length - pos, p.length)
      p.set(bytes.subarray(pos, pos + n), 0)
      pos += n
      return Promise.resolve(n)
    },
  }
}

const enc = (s: string) => new TextEncoder().encode(s)

Deno.test('parseSearchUids collects numbers, ignores empty/malformed', () => {
  assertEquals(parseSearchUids(['* SEARCH 1 2 3', 'a001 OK']), [1, 2, 3])
  assertEquals(parseSearchUids(['* SEARCH', 'a001 OK']), [])
  assertEquals(parseSearchUids(['* 3 EXISTS', 'a001 OK SEARCH done']), [])
  assertEquals(parseSearchUids(['* SEARCH 10', '* SEARCH 20 21']), [10, 20, 21])
})

Deno.test('parseSelect pulls UIDVALIDITY / UIDNEXT / EXISTS', () => {
  const lines = [
    '* 231 EXISTS',
    '* OK [UIDVALIDITY 1234567] UIDs valid',
    '* OK [UIDNEXT 400] Predicted next UID',
    'a002 OK [READ-WRITE] SELECT completed',
  ]
  assertEquals(parseSelect(lines), { uidValidity: 1234567, uidNext: 400, exists: 231 })
})

Deno.test('parseSelect tolerates missing fields', () => {
  assertEquals(parseSelect(['a002 OK done']), { uidValidity: null, uidNext: null, exists: null })
})

Deno.test('selectNewUids filters by cursor, keeps newest batch, oldest-first', () => {
  assertEquals(selectNewUids([1, 2, 3, 4, 5], 2, 10), [3, 4, 5])
  assertEquals(selectNewUids([5, 1, 3, 2, 4], 0, 3), [3, 4, 5]) // newest 3, ascending
  assertEquals(selectNewUids([10], 10, 5), []) // n:* returns the tail even when nothing is newer
})

Deno.test('ImapReader.readLine splits on CRLF across chunk boundaries', async () => {
  const r = new ImapReader(source(enc('* OK ready\r\na001 OK done\r\n'), 3))
  assertEquals(await r.readLine(), '* OK ready')
  assertEquals(await r.readLine(), 'a001 OK done')
  assertEquals(await r.readLine(), null)
})

Deno.test('readLineResponse returns the tagged verdict', async () => {
  const r = new ImapReader(source(enc('* CAPABILITY IMAP4rev1\r\na003 OK LOGIN completed\r\n')))
  const res = await readLineResponse(r, 'a003')
  assertEquals(res.ok, true)
  assertEquals(res.code, 'OK')
})

Deno.test('readLineResponse surfaces a NO verdict', async () => {
  const r = new ImapReader(source(enc('a004 NO [AUTHENTICATIONFAILED] bad creds\r\n')))
  const res = await readLineResponse(r, 'a004')
  assertEquals(res.ok, false)
  assertEquals(res.code, 'NO')
})

Deno.test('readFetchMessages reads UID + literal body, honoring byte counts', async () => {
  // The literal body deliberately contains a line that looks like a tagged
  // completion ("a005 OK ...") to prove byte-count framing beats line-splitting.
  const body = 'From: a@b.com\r\nSubject: hi\r\n\r\nbody line\r\na005 OK not really the end\r\n'
  const wire =
    `* 12 FETCH (UID 345 BODY[] {${body.length}}\r\n` +
    body +
    `)\r\n` +
    `* 13 FETCH (UID 346 BODY[] {5}\r\n` +
    `hello` +
    `)\r\n` +
    `a005 OK FETCH completed\r\n`
  const r = new ImapReader(source(enc(wire), 11))
  const msgs = await readFetchMessages(r, 'a005')
  assertEquals(msgs.length, 2)
  assertEquals(msgs[0].uid, 345)
  assertEquals(new TextDecoder().decode(msgs[0].body), body)
  assertEquals(msgs[1].uid, 346)
  assertEquals(new TextDecoder().decode(msgs[1].body), 'hello')
})
