// deno test — public table write-form logic. The `form-submit` endpoint is
// unauthenticated, so the allow-list intersection + coercion + required checks
// ARE the security/validation gate; keep them covered.
import { assertEquals } from 'jsr:@std/assert@1'
import { buildSubmissionRow, coerceValue, type TableColumn } from '../_shared/forms.ts'

const cols: TableColumn[] = [
  { key: 'name', label: 'Name', type: 'text' },
  { key: 'email', label: 'Email', type: 'text' },
  { key: 'age', label: 'Age', type: 'integer' },
  { key: 'rating', label: 'Rating', type: 'number' },
  { key: 'subscribe', label: 'Subscribe', type: 'boolean' },
  { key: 'when', label: 'When', type: 'date' },
  { key: 'meta', label: 'Meta', type: 'json' },
]

Deno.test('coerceValue: numbers, integers, booleans', () => {
  assertEquals(coerceValue('number', '9.5'), { value: 9.5 })
  assertEquals(coerceValue('integer', '3'), { value: 3 })
  assertEquals('error' in coerceValue('integer', '3.5'), true)
  assertEquals('error' in coerceValue('number', 'abc'), true)
  assertEquals(coerceValue('boolean', 'on'), { value: true })
  assertEquals(coerceValue('boolean', 'no'), { value: false })
  assertEquals(coerceValue('boolean', false), { value: false })
})

Deno.test('coerceValue: blank string -> null', () => {
  assertEquals(coerceValue('text', ''), { value: null })
  assertEquals(coerceValue('number', '   '), { value: null })
})

Deno.test('coerceValue: date and datetime', () => {
  assertEquals(coerceValue('date', '2026-08-02'), { value: '2026-08-02' })
  assertEquals('error' in coerceValue('date', 'not-a-date'), true)
  const dt = coerceValue('datetime', '2026-08-02T10:00:00Z')
  assertEquals('value' in dt && String((dt as { value: unknown }).value).startsWith('2026-08-02T10:00:00'), true)
})

Deno.test('coerceValue: json parses strings, passes objects', () => {
  assertEquals(coerceValue('json', '{"a":1}'), { value: { a: 1 } })
  assertEquals(coerceValue('json', { a: 1 }), { value: { a: 1 } })
  assertEquals('error' in coerceValue('json', '{bad'), true)
})

Deno.test('buildSubmissionRow: only allow-listed columns are written', () => {
  const { row, errors } = buildSubmissionRow(
    cols,
    [{ key: 'name' }, { key: 'email' }],
    // `age` is a real column but NOT in the form's allow-list, and `evil` isn't
    // a column at all — both must be dropped.
    { name: 'Jane', email: 'j@x.com', age: '99', evil: 'DROP TABLE', owner_id: 'attacker' },
  )
  assertEquals(errors, [])
  assertEquals(row, { name: 'Jane', email: 'j@x.com' })
})

Deno.test('buildSubmissionRow: required fields enforced', () => {
  const { errors } = buildSubmissionRow(
    cols,
    [{ key: 'name', required: true }, { key: 'email', required: true }],
    { name: 'Jane' },
  )
  assertEquals(errors.length, 1)
  assertEquals(errors[0].includes('Email'), true)
})

Deno.test('buildSubmissionRow: coerces typed values', () => {
  const { row, errors } = buildSubmissionRow(
    cols,
    [{ key: 'age' }, { key: 'rating' }, { key: 'subscribe' }, { key: 'meta' }],
    { age: '30', rating: '4.5', subscribe: 'true', meta: '{"src":"landing"}' },
  )
  assertEquals(errors, [])
  assertEquals(row, { age: 30, rating: 4.5, subscribe: true, meta: { src: 'landing' } })
})

Deno.test('buildSubmissionRow: bad type surfaces an error, not a bad write', () => {
  const { row, errors } = buildSubmissionRow(cols, [{ key: 'age' }], { age: 'not-a-number' })
  assertEquals(row, {})
  assertEquals(errors.length, 1)
})

Deno.test('buildSubmissionRow: blank optional field is skipped (not null-written)', () => {
  const { row, errors } = buildSubmissionRow(cols, [{ key: 'name' }, { key: 'email' }], { name: 'Jane', email: '' })
  assertEquals(errors, [])
  assertEquals(row, { name: 'Jane' })
})

Deno.test('buildSubmissionRow: required field pointing at a dropped column errors', () => {
  const { errors } = buildSubmissionRow(cols, [{ key: 'removed', required: true }], { removed: 'x' })
  assertEquals(errors.length, 1)
  assertEquals(errors[0].includes('no longer a column'), true)
})
