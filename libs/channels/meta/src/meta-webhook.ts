import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

import { MetaLimits, MetaWebhook } from '@platform/core/domain'

const HEX_SHA256 = /^[0-9a-f]{64}$/
const CHALLENGE = new RegExp(`^\\d{1,${MetaLimits.CHALLENGE_MAX_DIGITS}}$`)

// Hashing both sides gives buffers of one length, so the comparison neither throws nor leaks
// the length of the secret
function sameSecret(given: string, expected: string): boolean {
  const digest = (value: string): Buffer => createHash('sha256').update(value).digest()
  return timingSafeEqual(digest(given), digest(expected))
}

// `X-Hub-Signature-256` is `sha256=` and the hex HMAC of the raw body with the app secret. The body
// must be the bytes that arrived: a parsed and serialized one signs differently. Without a secret, or
// with a header that is missing or malformed, nothing is valid.
export function isValidMetaSignature(
  rawBody: string,
  signatureHeader: string | undefined,
  appSecret: string | undefined
): boolean {
  if (!appSecret || !signatureHeader?.startsWith(MetaWebhook.SIGNATURE_PREFIX)) return false
  const given = signatureHeader.slice(MetaWebhook.SIGNATURE_PREFIX.length).toLowerCase()
  if (!HEX_SHA256.test(given)) return false
  const expected = createHmac('sha256', appSecret).update(rawBody, 'utf8').digest()
  return timingSafeEqual(Buffer.from(given, 'hex'), expected)
}

// The GET Meta makes when the webhook is configured: it answers the challenge only for the right
// mode and token. The challenge is an integer, so anything else is refused instead of echoed back.
export function answerMetaHandshake(
  query: Record<string, unknown>,
  verifyToken: string | undefined
): string | null {
  // A query string can carry an array or an object (?a[]=x), whatever the type says
  const given = query[MetaWebhook.VERIFY_TOKEN_PARAM]
  const challenge = query[MetaWebhook.CHALLENGE_PARAM]
  if (!verifyToken || typeof given !== 'string' || typeof challenge !== 'string') return null
  if (query[MetaWebhook.MODE_PARAM] !== MetaWebhook.SUBSCRIBE_MODE) return null
  if (!sameSecret(given, verifyToken)) return null
  return CHALLENGE.test(challenge) ? challenge : null
}
