import { FiscalLimits } from '@platform/core/domain'

// A value the database takes in a Json column
// (never a bare null: a column of Json takes a value, and absent is `undefined`)
export type Json = string | number | boolean | Json[] | { [key: string]: Json }

// What comes out of a provider or a Json column is not trusted to be plain data: it takes the round trip through JSON, which drops what
// is not data (functions, undefined) and fails on what cannot be stored (a cycle)
export function toJson(value: unknown): Json {
  // A NUL character is valid JSON and not valid in a Json column of the database: it goes
  const text = JSON.stringify(value ?? {}, (_key, part: unknown) =>
    typeof part === 'string' ? part.replaceAll('\u0000', '') : part
  )
  return JSON.parse(text) as Json
}

// What the authority answered, kept with the document: a body larger than the limit is replaced by a note, never half stored
export function cappedResponse(response: unknown): Json {
  const json = toJson(response)
  return JSON.stringify(json).length > FiscalLimits.RESPONSE_MAX_CHARS ? { truncated: true } : json
}

export function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}
