import { createHmac, timingSafeEqual } from 'node:crypto'

import { z } from 'zod'

import { VISITOR_ID_PATTERN, WidgetLimits } from '@platform/core/domain'

// Mixed into the key so that the secret of the access tokens signs nothing else, whatever it is also
// used for
const KEY_PURPOSE = 'platform:widget-visitor-token:v1'

// What a token says: which connection (the site key) and which visitor it was given to, and until
// when. It is the only credential of the widget after the bootstrap.
const claimsSchema = z.object({
  c: z.string().min(1).max(64),
  v: z.string().regex(VISITOR_ID_PATTERN),
  exp: z.number().int()
})

// Whom a token is given to
export interface VisitorIdentity {
  siteKey: string
  visitorId: string
}

// What a good token says; `expiresAt` is in ms, for the socket that must close with it
export interface VisitorClaims extends VisitorIdentity {
  expiresAt: number
}

// The key the tokens are signed with, derived from the secret of the api
export function widgetTokenKey(secret: string): Buffer {
  return createHmac('sha256', secret).update(KEY_PURPOSE).digest()
}

function signature(key: Buffer, payload: string): Buffer {
  return createHmac('sha256', key).update(payload).digest()
}

// `<claims>.<signature>`, both base64url. Short-lived: the widget asks for a new one at each bootstrap.
export function signVisitorToken(key: Buffer, claims: VisitorIdentity, now = new Date()): string {
  const payload = Buffer.from(
    JSON.stringify({
      c: claims.siteKey,
      v: claims.visitorId,
      exp: Math.floor(now.getTime() / 1000) + WidgetLimits.TOKEN_TTL_SECONDS
    })
  ).toString('base64url')
  return `${payload}.${signature(key, payload).toString('base64url')}`
}

// The claims of a token that is ours and has not expired; null for anything else, without saying why
export function verifyVisitorToken(
  key: Buffer,
  token: unknown,
  now = new Date()
): VisitorClaims | null {
  if (typeof token !== 'string') return null
  const parts = token.split('.')
  if (parts.length !== 2) return null
  const [payload = '', given = ''] = parts
  const expected = signature(key, payload)
  // Compared as the string we would have written: a decoder skips characters, so two strings would
  // otherwise stand for one signature
  const received = Buffer.from(given, 'base64url')
  if (
    given !== received.toString('base64url') ||
    received.length !== expected.length ||
    !timingSafeEqual(received, expected)
  ) {
    return null
  }
  let decoded: unknown
  try {
    decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
  } catch {
    return null
  }
  const claims = claimsSchema.safeParse(decoded)
  if (!claims.success || claims.data.exp * 1000 <= now.getTime()) return null
  return { siteKey: claims.data.c, visitorId: claims.data.v, expiresAt: claims.data.exp * 1000 }
}
