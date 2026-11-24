// What a request of the api gets when Redis cannot be reached. The client of the platform (redis.module.ts) fails a
// command fast so that a Redis that is down does not hang every request: one retry (MaxRetriesPerRequestError) or the
// half second of `commandTimeout` ("Command timed out"). Public routes that need Redis (the magic link, the
// unsubscribe, the intake of a data request) used to answer those as a 500 INTERNAL_ERROR, a page for something that
// is not a bug and that the caller can simply try again.
export const REDIS_RETRY_AFTER_SECONDS = 5

const MAX_DEPTH = 6
const CAUSE_KEYS = ['cause', 'originalError'] as const
// The names ioredis gives to the failures of reaching the server (it exports them as classes). Only what is ioredis's own: a
// generic `AbortError` or a network code (ECONNREFUSED...) can come from a database, a bucket or an outbound call, and would
// blame Redis for it and hide it from the reports
const UNREACHABLE_NAMES: ReadonlySet<string> = new Set([
  'MaxRetriesPerRequestError',
  'ClusterAllFailedError'
])
// Whole messages, never a part: the messages of ioredis are fixed texts, and a match on a part could turn
// an error that carries text a user typed into a retryable answer that is not reported
const UNREACHABLE_MESSAGES: ReadonlySet<string> = new Set([
  'Command timed out',
  'Connection is closed.'
])

// Whether an error is the client of Redis saying that the server cannot be reached (or did not answer in time). Looked
// for by shape, in the error and in the errors it wraps, to a fixed depth so a cycle cannot loop.
export function isRedisUnavailableError(error: unknown, depth = 0): boolean {
  if (depth > MAX_DEPTH || typeof error !== 'object' || error === null) return false
  const record = error as Record<string, unknown>
  if (typeof record['name'] === 'string' && UNREACHABLE_NAMES.has(record['name'])) return true
  if (error instanceof Error && UNREACHABLE_MESSAGES.has(error.message)) return true
  return CAUSE_KEYS.some(key => isRedisUnavailableError(record[key], depth + 1))
}
