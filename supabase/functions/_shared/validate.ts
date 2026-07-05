// Payload validation for the webhook "deterministic mode" (webhooks.tool_id):
// the inbound JSON is checked against the target tool's input_schema BEFORE
// anything runs — on that path no model is in the loop, so this validation IS
// the gate. Extracted from the webhook function so it's unit-testable.

export function jsonType(v: unknown): string {
  if (Array.isArray(v)) return 'array'
  if (v === null) return 'null'
  return typeof v
}

// Validate an inbound payload against a tool's input_schema (a JSON Schema). A
// pragmatic subset: required-field presence + top-level type checks for declared
// properties. Returns a list of human-readable problems (empty = valid).
export function validatePayload(schema: Record<string, unknown>, payload: unknown): string[] {
  if (jsonType(payload) !== 'object') return ['payload must be a JSON object']
  const obj = payload as Record<string, unknown>
  const props = (schema?.properties ?? {}) as Record<string, { type?: string }>
  const required = Array.isArray(schema?.required) ? (schema.required as string[]) : []
  const errors: string[] = []
  for (const key of required) {
    if (obj[key] === undefined || obj[key] === null) errors.push(`missing required field "${key}"`)
  }
  for (const [key, spec] of Object.entries(props)) {
    const val = obj[key]
    if (val === undefined || val === null) continue
    const want = spec?.type
    if (!want) continue
    const got = jsonType(val)
    const ok =
      want === 'integer' ? got === 'number' && Number.isInteger(val) :
      want === 'number' ? got === 'number' :
      got === want
    if (!ok) errors.push(`field "${key}" should be ${want}, got ${got}`)
  }
  return errors
}
