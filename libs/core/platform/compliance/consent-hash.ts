import { createHash, createHmac } from 'node:crypto'

// The key that hashes the address of a visitor who answers the cookie banner (`cookie_consents.ip_hash`, TDD_05 §10.5), and the name
// of that key, so that a row says which key made its hash.
//   * `id` null: the key derived from the signing secret, the only key there was before Step 7.2-K2. Its hashes are bare hex
//     (64 characters), and a laptop or a test run that sets no `CONSENT_HASH_KEY` still makes them, so nothing written before changes.
//   * `id` set: the key of `CONSENT_HASH_KEY`. Its id is derived from the key itself (`k` and 8 hex characters of its SHA-256), so a
//     rotated key can never go on under the old name, and its hashes are `<id>:<hex>`. The id gives away nothing usable of the key.
// Rows are never rehashed on a rotation: the address is not kept (that is the point of the hash), so it cannot be. Old rows and new
// rows live together, each one naming its key; the hash is a proof of origin, not an identifier, and nothing compares across rows.
export interface ConsentHashKey {
  key: string
  id: string | null
}

// The label of the key derived from the signing secret: its own, so the signing secret itself is never the key of anything else
const DERIVED_KEY_LABEL = 'cookie-consent-ip-hash-key:v1'

// The name of an own key: the same key always has the same name and a new key never has the old one
export const consentHashKeyNameOf = (key: string): string =>
  `k${createHash('sha256').update(key).digest('hex').slice(0, 8)}`

export function consentHashKeyOf(input: {
  jwtSecret: string
  consentHashKey: string | undefined
}): ConsentHashKey {
  if (input.consentHashKey !== undefined) {
    return { key: input.consentHashKey, id: consentHashKeyNameOf(input.consentHashKey) }
  }
  return {
    key: createHmac('sha256', input.jwtSecret).update(DERIVED_KEY_LABEL).digest('hex'),
    id: null
  }
}

// A keyed hash of the address: the proof that a choice came from somewhere, without keeping the address (TDD_05 §10.5)
export function hashClientAddress(address: string, hashKey: ConsentHashKey): string {
  const digest = createHmac('sha256', hashKey.key).update(address).digest('hex')
  return hashKey.id === null ? digest : `${hashKey.id}:${digest}`
}

// The key a stored hash names: null for the bare hex of the derived key, the id for `<id>:<hex>`, undefined for anything else
export function consentHashKeyIdOf(stored: string): string | null | undefined {
  if (/^[0-9a-f]{64}$/.test(stored)) return null
  return /^([a-z0-9]{1,16}):[0-9a-f]{64}$/.exec(stored)?.[1]
}
