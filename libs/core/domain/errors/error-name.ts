// The name of what was thrown, and nothing else: the message of an error from a provider or a plugin
// can hold the token it was called with, so logs and job failures carry the name only. It runs inside
// the handlers of failures, so it never throws: an error whose `name` is a getter that throws has no name.
export function errorName(error: unknown): string {
  try {
    return error instanceof Error ? error.name : 'unknown'
  } catch {
    return 'unknown'
  }
}
