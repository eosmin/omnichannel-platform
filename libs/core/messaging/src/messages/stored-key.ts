// The idempotency key as it is stored. A key is unique per conversation, so one shared by every author would let a plugin learn that
// another author used a key (a conflict instead of a new message): a plugin's key lives under its own namespace, and two authors can
// never meet on one (HC-216). A person's key is stored as it came.
const PLUGIN_KEY_PREFIX = 'plugin:'

export function storedKeyOf(key: string | undefined, pluginId: string | null): string | null {
  if (key === undefined) return null
  return pluginId === null ? key : `${PLUGIN_KEY_PREFIX}${pluginId}:${key}`
}

// The key as the author wrote it: what travels back to the browsers and the plugins (their payloads allow no `:`)
export function rawKeyOf(stored: string | null): string | null {
  if (stored === null || !stored.startsWith(PLUGIN_KEY_PREFIX)) return stored
  const at = stored.indexOf(':', PLUGIN_KEY_PREFIX.length)
  return at === -1 ? stored : stored.slice(at + 1)
}
