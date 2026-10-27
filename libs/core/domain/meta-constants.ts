// What the three Meta channels (WhatsApp, Instagram, Messenger) share: one app, one webhook
// signature, one Graph API.
export const MetaWebhook = {
  SIGNATURE_HEADER: 'x-hub-signature-256',
  SIGNATURE_PREFIX: 'sha256=',
  MODE_PARAM: 'hub.mode',
  VERIFY_TOKEN_PARAM: 'hub.verify_token',
  CHALLENGE_PARAM: 'hub.challenge',
  SUBSCRIBE_MODE: 'subscribe'
} as const

export const MetaGraph = {
  ORIGIN: 'https://graph.facebook.com',
  // The one host that wants the connection token to give a file. Exact on purpose: other
  // *.fbsbx.com hosts (apps.fbsbx.com) serve content of third parties.
  MEDIA_TOKEN_HOSTS: ['lookaside.fbsbx.com'],
  // CDNs a media url may point to. They are followed without the token. A media url outside both
  // lists is refused, so a forged answer cannot make the worker call an internal address.
  MEDIA_CDN_SUFFIXES: ['.fbcdn.net', '.whatsapp.net']
} as const

// Statuses that say "not now" without being a 5xx: request timeout and too early
export const MetaTransientStatuses = [408, 425] as const

export const MetaLimits = {
  REQUEST_TIMEOUT_MS: 15_000,
  MEDIA_TIMEOUT_MS: 60_000,
  // WhatsApp accepts documents up to 100 MB, the largest media it carries
  MEDIA_MAX_BYTES: 100 * 1024 * 1024,
  // The challenge Meta sends is an integer
  CHALLENGE_MAX_DIGITS: 20
} as const

// The error codes of the Graph API (https://developers.facebook.com/docs/graph-api/guides/error-handling).
export const MetaErrorCodes = {
  // The token is expired, revoked or lacks the permission: the owner has to connect again
  INVALID_TOKEN: 190,
  PERMISSION_DENIED: 10,
  // 200 to 299 are permission errors as well
  PERMISSION_RANGE_START: 200,
  PERMISSION_RANGE_END: 299,
  // Throttling: Meta did not do the work, so trying again later is safe. 130429 and 131056 are the
  // WhatsApp Cloud API ones (throughput and pair rate limit)
  RATE_LIMITS: [
    4, 17, 32, 613, 80000, 80001, 80002, 80003, 80004, 80005, 80006, 80008, 80009, 80014, 130429,
    131056
  ],
  // Failure on Meta's side (131000 and 131016 are WhatsApp's): the work may or may not have been done
  TEMPORARY: [1, 2, 131000, 131016]
} as const
