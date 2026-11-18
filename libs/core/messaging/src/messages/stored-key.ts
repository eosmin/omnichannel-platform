// The idempotency key as it is stored. A key is unique per conversation, so one shared by every author would let a plugin learn that
// another author used a key (a conflict instead of a new message): a plugin's key lives under its own namespace, and two authors can
// never meet on one (HC-216). A person's key is stored as it came.
export function storedKeyOf(key: string | undefined, pluginId: string | null): string | null {
  if (key === undefined) return null
  return pluginId === null ? key : `plugin:${pluginId}:${key}`
}
