import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  dumpKey,
  encodeObjectPath,
  needsCopy,
  parseList,
  resolveTenants,
  runKey,
  sqlLiteral,
  stamp,
  storageKey,
  storagePrefix,
} from './plan.ts'

const A = 'abcdefghijklmnopqrst'
const B = 'bbbbbbbbbbbbbbbbbbbb'

test('resolveTenants dedupes, drops bad refs, and appends extra refs', () => {
  const tenants = resolveTenants(
    [
      { id: '1', slug: 'acme', project_ref: A },
      { id: '2', slug: 'dup', project_ref: A },
      { id: '3', slug: 'bad', project_ref: 'not-a-ref' },
      { id: '4', slug: 'none', project_ref: null },
    ],
    [B, A, 'nope'],
  )
  assert.deepEqual(tenants, [
    { id: '2', slug: 'dup', ref: A },
    { id: null, slug: B, ref: B },
  ])
})

test('parseList splits on commas and whitespace', () => {
  assert.deepEqual(parseList(` ${A}, ${B}\n`), [A, B])
  assert.deepEqual(parseList(undefined), [])
})

test('keys are prefix-first and colon-free', () => {
  const s = stamp(new Date('2026-09-29T07:00:00.123Z'))
  assert.equal(s, '2026-09-29T07-00-00Z')
  assert.equal(dumpKey('', A, s), `db/${A}/2026-09-29T07-00-00Z.dump`)
  assert.equal(dumpKey('/supanet/', A, s), `supanet/db/${A}/2026-09-29T07-00-00Z.dump`)
  assert.equal(storagePrefix('', A), `storage/${A}/`)
  assert.equal(storageKey('', A, 'files', 'u1/x/a b.pdf'), `storage/${A}/files/u1/x/a b.pdf`)
  assert.equal(runKey('', s), 'runs/2026-09-29T07-00-00Z.json')
})

test('needsCopy skips only an unchanged, same-size mirrored object', () => {
  const obj = { bucket: 'files', name: 'a', size: 10, updatedAt: '2026-09-01T00:00:00Z' }
  assert.equal(needsCopy(obj, undefined), true)
  assert.equal(needsCopy(obj, { size: 10, lastModified: new Date('2026-09-02T00:00:00Z') }), false)
  assert.equal(needsCopy(obj, { size: 11, lastModified: new Date('2026-09-02T00:00:00Z') }), true)
  assert.equal(needsCopy(obj, { size: 10, lastModified: new Date('2026-08-31T00:00:00Z') }), true)
  assert.equal(needsCopy({ ...obj, size: null }, { size: 10, lastModified: new Date() }), true)
  assert.equal(needsCopy({ ...obj, updatedAt: null }, { size: 10, lastModified: new Date() }), true)
})

test('encodeObjectPath keeps separators and escapes segments', () => {
  assert.equal(encodeObjectPath('u1/my file#1.pdf'), 'u1/my%20file%231.pdf')
})

test('sqlLiteral escapes quotes', () => {
  assert.equal(sqlLiteral("o'brien"), "'o''brien'")
  assert.equal(sqlLiteral(null), 'null')
})
