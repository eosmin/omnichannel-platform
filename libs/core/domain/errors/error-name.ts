// The name of what was thrown, and nothing else: the message of an error from a provider or a plugin
// can hold the token it was called with, so logs and job failures carry the name only.
export function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown'
}
