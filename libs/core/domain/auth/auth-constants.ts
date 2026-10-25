// Magic link: single use, short life (MVP_TRIM_CHECKLIST.md D1)
export const MAGIC_LINK_TTL_MINUTES = 15

// Where the web app consumes a link. The token travels in the fragment (#token=...), which the browser
// never sends to a server, so it stays out of access logs and Referer headers; the page reads it and
// POSTs it to ApiRoutes.auth.magicLinkConsume.
export const MAGIC_LINK_WEB_PATH = '/login/verify'
export const MAGIC_LINK_FRAGMENT_KEY = 'token'

// Requests per window, per client (TDD_05 section 3.1; MVP_TRIM_CHECKLIST.md D2). The profiles are
// ThrottlerNames; a named endpoint may use a stricter limit than its profile.
export const ThrottleProfiles = {
  DEFAULT: { limit: 100, ttlMs: 60_000 },
  PUBLIC: { limit: 30, ttlMs: 60_000 }
} as const

// The login profile of D2: 5 a minute per IP, and the same per hashed email, so the endpoint cannot
// be used to mail-bomb an address from many IPs
export const MagicLinkThrottle = { limit: 5, ttlMs: 60_000 } as const

// The claims of the access token. `email` is there for the Bull Board allowlist.
export interface AccessTokenClaims {
  sub: string // User id
  sid: string // Session family id: the login this token belongs to
  email: string
}

// What the AuthGuard puts in request.user once the access token verified
export interface AuthenticatedUser {
  id: string
  sessionFamilyId: string
  email: string
}

// Session.revokedReason: why a family of refresh tokens stopped working
export const SessionRevokedReasons = {
  LOGOUT: 'logout',
  REVOKED_BY_USER: 'revoked_by_user', // From the list of sessions
  REUSE_DETECTED: 'reuse_detected' // A refresh token that was already used came back
} as const
export type SessionRevokedReason =
  (typeof SessionRevokedReasons)[keyof typeof SessionRevokedReasons]

// The name under which the per-email limit of the magic link is counted in the throttler storage
export const MAGIC_LINK_EMAIL_THROTTLER = 'magic-link-email'
