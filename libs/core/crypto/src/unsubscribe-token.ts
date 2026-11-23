import { createHmac, timingSafeEqual } from 'node:crypto'

// The signed token of the one-click unsubscribe link of the notification emails (Step 7.3, B6b-3b2b). It names the person (an opaque id, never
// an address or a name) and what is switched off, and nothing else: no store, no date. Opening the link twice does the same thing twice (it sets
// a choice, it does not toggle it), so the token needs no memory on our side. Its life is the life of its key: a key that is replaced ends every
// link made under the old one.
//
// Format: `v1.<scope>.<id>.<mac>`; the mac is an HMAC-SHA256 of a label of its own, the scope and the id, under a key that is not the signing
// secret of the sessions (`UNSUBSCRIBE_TOKEN_KEY`, or one derived from `JWT_SECRET` with its own label where the env sets none).
export const UnsubscribeScopes = {
  // The email of the notifications: sets the digest frequency of the person to off
  NOTIFICATION_EMAIL: 'ne'
} as const
export type UnsubscribeScope = (typeof UnsubscribeScopes)[keyof typeof UnsubscribeScopes]

const VERSION = 'v1'
// Domain separation: a mac made for another purpose with the same key never verifies here, and the reverse
const MAC_LABEL = 'notification-unsubscribe-token:v1'
const DERIVED_KEY_LABEL = 'notification-unsubscribe-key:v1'
// An id is a cuid or a uuid: letters, digits and dashes, short. Anything else is refused before any mac is computed
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/
const MAC_HEX_LENGTH = 64

export function unsubscribeKeyOf(input: {
  jwtSecret: string
  unsubscribeTokenKey: string | undefined
}): string {
  if (input.unsubscribeTokenKey !== undefined) return input.unsubscribeTokenKey
  return createHmac('sha256', input.jwtSecret).update(DERIVED_KEY_LABEL).digest('hex')
}

function macOf(key: string, scope: string, id: string): string {
  return createHmac('sha256', key).update(`${MAC_LABEL}\n${scope}\n${id}`).digest('hex')
}

export function signUnsubscribeToken(key: string, scope: UnsubscribeScope, id: string): string {
  if (!ID_PATTERN.test(id)) throw new Error('the id of an unsubscribe token has an invalid shape')
  return `${VERSION}.${scope}.${id}.${macOf(key, scope, id)}`
}

export interface VerifiedUnsubscribeToken {
  scope: UnsubscribeScope
  id: string
}

// null for anything that is not a token made under this key: the caller answers the same for every reason, so nothing says which part failed
export function verifyUnsubscribeToken(
  key: string,
  token: string
): VerifiedUnsubscribeToken | null {
  if (token.length > 256) return null
  const parts = token.split('.')
  if (parts.length !== 4) return null
  const [version, scope, id, mac] = parts as [string, string, string, string]
  if (version !== VERSION) return null
  if (!Object.values<string>(UnsubscribeScopes).includes(scope)) return null
  if (!ID_PATTERN.test(id) || mac.length !== MAC_HEX_LENGTH) return null
  const expected = Buffer.from(macOf(key, scope, id), 'hex')
  const given = Buffer.from(mac, 'hex')
  // A mac that is not hex decodes shorter: the length check keeps `timingSafeEqual` from throwing
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null
  return { scope: scope as UnsubscribeScope, id }
}
