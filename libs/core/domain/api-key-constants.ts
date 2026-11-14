import { type Permission, Permissions } from './auth/permissions'

export const ApiKeyLimits = {
  MAX_PER_STORE: 50, // Active keys
  LIST_MAX: 200, // The list returns the newest rows, revoked ones included
  NAME_MAX_LENGTH: 80,
  SECRET_BYTES: 32, // 256 bits, so the hash alone is enough to keep (no salt, no stretching)
  // The only thing of a key that is shown again: its first characters, enough to tell two keys apart
  DISPLAY_PREFIX_LENGTH: 12,
  // The time of last use is written at most this often: a busy key would turn every call into a write
  LAST_USED_WRITE_INTERVAL_MS: 60_000
} as const

// A tenant key starts with this, so a leaked one is found by a secret scanner and told from a plugin key
export const API_KEY_TOKEN_PREFIX = 'pk_live_'

// The scopes of a key are permissions, but only those of the resources an integration works with. A permission under any other
// prefix, today or when one is added, is not a scope until somebody puts its prefix here: a key never runs the account (settings,
// team, organization) by default.
export const ApiKeyScopePrefixes = [
  'conversations:',
  'messages:',
  'customers:',
  'orders:',
  'products:',
  'inventory:',
  'shipping:',
  'returns:',
  'remittances:',
  'media:'
] as const

export function isApiKeyScope(permission: string): permission is Permission {
  return (
    (Object.values(Permissions) as string[]).includes(permission) &&
    ApiKeyScopePrefixes.some(prefix => permission.startsWith(prefix))
  )
}
