import { hashToken } from '@platform/core/crypto'
import { PluginIdempotency } from '@platform/core/domain'

// Visible ASCII only (no space, no control character), 1 to KEY_MAX_LENGTH: what the CHECK of the table accepts too
const KEY_PATTERN = new RegExp(`^[\\x21-\\x7e]{1,${PluginIdempotency.KEY_MAX_LENGTH}}$`)

// The key of the header, or null when it is not one a plugin may send (empty, too long, with a space or a control character; a header
// sent twice reaches Node joined by ", ", so it fails on the space)
export function idempotencyKeyOf(header: string | readonly string[] | undefined): string | null {
  if (typeof header !== 'string') return null
  return KEY_PATTERN.test(header) ? header : null
}

// The same JSON with the keys of every object in order, so that two bodies that differ only in the order of their keys are the same
// request
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) => {
    if (inner === null || typeof inner !== 'object' || Array.isArray(inner)) return inner
    const sorted: Record<string, unknown> = {}
    for (const name of Object.keys(inner).sort()) {
      sorted[name] = (inner as Record<string, unknown>)[name]
    }
    return sorted
  })
}

// What a key is tied to: the method, the address as it came (the ids in the path and the query) and the body. A key sent again with
// anything else is another request and is refused, never answered with the first one's result.
export function requestFingerprint(request: {
  method: string
  originalUrl: string
  body?: unknown
}): string {
  return hashToken(canonicalJson([request.method, request.originalUrl, request.body ?? null]))
}
