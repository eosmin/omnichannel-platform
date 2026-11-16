import { FiscalLimits } from '@platform/core/domain'

// A value the database takes in a Json column
// (never a bare null: a column of Json takes a value, and absent is `undefined`)
export type Json = string | number | boolean | Json[] | { [key: string]: Json }

// What comes out of a provider or a Json column is not trusted to be plain data: it takes the round trip through JSON, which drops what
// is not data (functions, undefined) and fails on what cannot be stored (a cycle)
// A text the database takes: no NUL character (valid in JSON, refused by Postgres in a TEXT and in a jsonb) and no lone surrogate (an
// invalid text that jsonb refuses too). What a provider returns is not trusted to be storable.
export function plainText(value: string): string {
  return value
    .replaceAll('\u0000', '')
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '\uFFFD')
}

function scrub(value: unknown): unknown {
  if (typeof value === 'string') return plainText(value)
  if (Array.isArray(value)) return value.map(scrub)
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, part]) => [
        plainText(key),
        scrub(part)
      ])
    )
  }
  return value
}

export function toJson(value: unknown): Json {
  // The round trip drops what is not data (a function, undefined) and fails on what cannot be stored (a cycle)
  return JSON.parse(JSON.stringify(scrub(JSON.parse(JSON.stringify(value ?? {}))))) as Json
}

// What the authority answered, kept with the document: a body larger than the limit is replaced by a note, never half stored
export function cappedResponse(
  response: unknown,
  max: number = FiscalLimits.RESPONSE_MAX_CHARS
): Json {
  const json = toJson(response)
  return JSON.stringify(json).length > max ? { truncated: true } : json
}

export function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}
