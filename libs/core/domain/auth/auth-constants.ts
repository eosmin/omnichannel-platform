// Magic link: single use, short life (MVP_TRIM_CHECKLIST.md D1)
export const MAGIC_LINK_TTL_MINUTES = 15

// Where the web app consumes a link. The token travels in the fragment (#token=...), which the browser
// never sends to a server, so it stays out of access logs and Referer headers; the page reads it and
// POSTs it to ApiRoutes.auth.magicLinkConsume.
export const MAGIC_LINK_WEB_PATH = '/login/verify'
export const MAGIC_LINK_FRAGMENT_KEY = 'token'

// An invitation: 7 days to accept (Step 1.4). The link goes to the web page that previews it and
// accepts it; the token is the last segment of the path.
export const INVITATION_TTL_DAYS = 7
export const INVITATION_WEB_PATH = '/invitations'
// Inviting an address again replaces the invitation, but not before this long: it is also a way to
// send an email, and one address must not be mail-bombed from a store
export const INVITATION_RESEND_COOLDOWN_SECONDS = 60
// The key of the metadata of a 429 that says how long to wait: the api writes it, the web reads it
export const RETRY_AFTER_METADATA_KEY = 'retryAfterSeconds'

// Requests per window, per client (TDD_05 section 3.1; MVP_TRIM_CHECKLIST.md D2). The profiles are
// ThrottlerNames; a named endpoint may use a stricter limit than its profile.
export const ThrottleProfiles = {
  DEFAULT: { limit: 100, ttlMs: 60_000 },
  PUBLIC: { limit: 30, ttlMs: 60_000 }
} as const

// A provider's webhook sends every message of every store it serves from a few addresses, and the
// signature of the body is what authenticates it, so the limit is far above the default
export const ChannelWebhookThrottle = { limit: 600, ttlMs: 60_000 } as const

// A carrier pushes the status of the shipments of every store it serves from a few addresses, authenticated by the secret of
// the connection: the same reasoning as a channel's webhook
export const CarrierWebhookThrottle = { limit: 600, ttlMs: 60_000 } as const

// The plugin API from one address: a plugin serves every store that installed it from a few addresses, and the key and the
// limit of the installation (PluginApiKeyGuard) are what authenticate and bound each call, so this is only the flood guard
export const PluginApiIpThrottle = { limit: 3000, ttlMs: 60_000 } as const

// The keys that did not open the door, per address (Step 7.3, PR S3). The flood guard above counts every call, good or bad, so it
// has to be far above what a plugin does; a made-up key costs a database lookup (and, on the events route, a read of up to 1 MiB)
// before the guard answers 401, so the failures have their own, much lower limit. Only a failure is counted: a plugin with a good
// key from the same address is not slowed by its own traffic. Past the limit the address is refused with 429 before the key is
// looked up and before the large body is read, for the rest of the window. `name` is the counter in Redis and the `throttler` label
// of the metric.
export const PluginApiKeyProbeThrottle = {
  name: 'plugin_key_probe',
  limit: 30,
  ttlMs: 60_000
} as const

// Every refusal of a key (missing, malformed, unknown, revoked, disabled or of a suspended plugin) takes at least this long, so the
// time of the answer does not say how far the lookup went. It is above what the lookups take; the probe limit bounds how many
// requests per address can wait on it.
export const PluginApiKeyRefusalFloorMs = 100

// The routes that can be used to enumerate what a store holds (the search, the click of a result, the list of customers) are
// limited in two layers (TDD_05 §3.1). The first is per address, before anybody is authenticated: it is only the flood guard, so
// it is far above the default, because an office shares one address and many people type in a search box at once. It cannot be
// the only one: an attacker with many addresses is never held by it.
export const EnumerationIpThrottle = { limit: 600, ttlMs: 60_000 } as const

// The second layer counts per authenticated user, after the token, the store and the permission were checked (UserRateLimitGuard),
// so the address does not matter: a person who types fast does not reach it, a script that walks the data does. `name` is the
// counter, shared by every route that names the same profile (the search of customers and the global search spend one budget).
export interface UserRateLimitProfile {
  readonly name: string
  readonly limit: number
  readonly ttlMs: number
}
// The name a profile is counted under (the key in Redis and the `throttler` label of the metric): apart from the per-address ones
export const userRateLimitThrottler = (profile: UserRateLimitProfile): string =>
  `user:${profile.name}`
export const USER_RATE_LIMIT_METADATA_KEY = 'userRateLimit'
export const UserRateLimits = {
  SEARCH: { name: 'search', limit: 180, ttlMs: 60_000 },
  SEARCH_CLICKS: { name: 'search_clicks', limit: 120, ttlMs: 60_000 },
  CUSTOMER_LIST: { name: 'customer_list', limit: 120, ttlMs: 60_000 }
} as const satisfies Record<string, UserRateLimitProfile>

// The general budget of an authenticated person, counted by the user id after the token, the store and the permission were
// checked (AuthenticatedUserRateLimitGuard; TDD_05 §3.1; the `user:authenticated` counter), on every route behind AuthGuard and
// on top of the per-address default. The address does not matter: it holds a person whose token is used from many addresses, which
// the per-address layer never sees as one. It is far above what the web does (the inbox, polling and the realtime fallback
// together stay in the tens a minute), so it only stops a script. It does not replace the per-address default, which stays as it
// is: raising that one for offices is a decision of the owner (IMPLEMENTATION_PLAN.md, Step 7.1).
export const AuthenticatedUserRateLimit = {
  name: 'authenticated',
  limit: 600,
  ttlMs: 60_000
} as const satisfies UserRateLimitProfile

// What the browser suite may ask for instead of that budget, in NODE_ENV=test only (E2E_USER_RATE_LIMIT): it can only be raised, never
// turned off, and never past a bound. The suite signs in as the same few people for hundreds of page loads a minute (every page
// polls), far more than one person does.
export const E2eUserRateLimit = {
  min: AuthenticatedUserRateLimit.limit + 1,
  max: 1_000_000,
  suite: 100_000
} as const

// The provider of the budget in force: the profile above unless the test environment raised the limit
export const AUTHENTICATED_USER_RATE_LIMIT = Symbol('AUTHENTICATED_USER_RATE_LIMIT')
export function authenticatedUserRateLimitOf(
  raisedForTests: number | undefined
): UserRateLimitProfile {
  return raisedForTests === undefined
    ? AuthenticatedUserRateLimit
    : { ...AuthenticatedUserRateLimit, limit: raisedForTests }
}

// The public form of data subject requests (Step 7.2-H1): few a ten minutes from one address, because one request mails a link to a
// person who may not have asked. The counts per address and per store (ComplianceConfig.DSR_INTAKE_*) are the second layer.
export const DsrIntakeThrottle = { limit: 5, ttlMs: 600_000 } as const
// Confirming a request with the token of the mail: the token has 256 bits, so this is only the flood guard
export const DsrVerifyThrottle = { limit: 20, ttlMs: 600_000 } as const

// The public one-click unsubscribe of the notification emails (Step 7.3, B6b-3b2b). Per address: only a flood guard on a route that needs no session,
// and wide on purpose: the one-click POSTs of a mailbox provider come from its few server addresses, shared by all its users, so the real limit is the one per token.
// Per token: one person's link is not worth more than a few tries from anywhere (a mail client that retries, a person who taps twice), so a
// token that is hammered from many addresses is cut too. Both answer 429 for everyone alike, never a word about the token.
export const UnsubscribeThrottle = { limit: 300, ttlMs: 600_000 } as const
export const UnsubscribeTokenThrottle = { limit: 10, ttlMs: 600_000 } as const

// The login profile of D2: 5 a minute per IP, and the same per hashed email, so the endpoint cannot
// be used to mail-bomb an address from many IPs
export const MagicLinkThrottle = { limit: 5, ttlMs: 60_000 } as const

// The provider of that limit for the per-address count: the limit of the code unless the test environment raised it
// (see `MagicLinkLimitPlatformModule`)
export const MAGIC_LINK_EMAIL_LIMIT = Symbol('MAGIC_LINK_EMAIL_LIMIT')

// What the browser suite may ask for instead of that limit, in NODE_ENV=test only (E2E_MAGIC_LINK_LIMIT): it can
// only be raised, never turned off, and never past a bound. The suite signs in as the same few people dozens of
// times, and waiting for the clock was half of its time.
export const E2eMagicLinkLimit = { min: MagicLinkThrottle.limit + 1, max: 100, suite: 50 } as const

// The per-address limit in force: the real one, unless the test environment asked for a higher one
export function magicLinkEmailLimitOf(raisedForTests: number | undefined): number {
  return raisedForTests ?? MagicLinkThrottle.limit
}

// Accepting an invitation: the old signup profile of D2, 3 an hour per IP. It can create an account.
export const InvitationAcceptThrottle = { limit: 3, ttlMs: 3_600_000 } as const

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

// A refresh token that was already used is accepted ONE more time when it comes back within this many
// seconds of being used and its successor has not been used (TDD_01 section 7). It covers the answer
// of a refresh that never reached the browser (a reload with the request in flight); past it, or a
// second time, the login is revoked as a leak. Keep it short: for these seconds a copy of the old
// token is worth as much as the original.
export const REFRESH_REUSE_GRACE_SECONDS = 10

// The name under which the per-email limit of the magic link is counted in the throttler storage
export const MAGIC_LINK_EMAIL_THROTTLER = 'magic-link-email'
