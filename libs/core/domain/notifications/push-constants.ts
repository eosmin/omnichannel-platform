import type { NotificationSeverityType, NotificationType } from './notification-constants'

export const PushLimits = {
  // A person has a phone, a laptop, a few browsers; past this the oldest registration is dropped
  MAX_SUBSCRIPTIONS_PER_USER: 20,
  // How long the push service keeps a message for a device that is off (seconds)
  TTL_SECONDS: 3600,
  // A push service that accepts the connection and stalls must not hold a worker slot for ever
  REQUEST_TIMEOUT_MS: 10_000,
  // The api does not wait longer than this for the queue: the push is lost, the action is not held
  ENQUEUE_TIMEOUT_MS: 2000,
  // A push message is encrypted into at most 4096 bytes; the text is cut well below that
  MAX_TITLE_LENGTH: 80,
  MAX_BODY_LENGTH: 200,
  MAX_ENDPOINT_LENGTH: 2048,
  MAX_KEY_LENGTH: 256,
  // The decoded size of the keys of a browser (a P-256 point, a 16-byte secret) and of the VAPID pair
  P256DH_BYTES: 65,
  AUTH_BYTES: 16,
  VAPID_PUBLIC_BYTES: 65,
  VAPID_PRIVATE_BYTES: 32,
  MAX_USER_AGENT_LENGTH: 512,
  // A browser the push service refuses for good (not gone: a payload or a key it will not take) this many times in a row is dropped;
  // one delivered push resets the count. A person who still wants push registers again from the switch.
  MAX_REFUSALS: 5,
  // A 400 is counted against a browser only while this process has delivered at least one push among its last SOUND_WINDOW attempts: a
  // fault of the server (a payload or a header every push service refuses) delivers nothing, so it proves nothing about the browsers and
  // must not empty their lists. Fail-safe: a fresh process, or one that delivers nothing, counts nothing and drops nothing.
  SOUND_WINDOW: 200
} as const

// What became of one push to one browser: the label of `platform_web_push_attempts_total`. The refusals are told apart by what they
// say about the fault (a 400 names the browser; the rest name the server), so an alert can watch the ones that are the server's.
export const PushOutcomes = {
  DELIVERED: 'delivered',
  GONE: 'gone',
  RETRY: 'retry',
  REFUSED_BAD_REQUEST: 'refused_bad_request',
  // 401 and 403: the VAPID key is wrong, rotated, or not the one the browser subscribed with
  REFUSED_AUTH: 'refused_auth',
  REFUSED_TOO_LARGE: 'refused_too_large',
  // An HTTP refusal that is none of the above
  REFUSED_OTHER: 'refused_other',
  // An error of the library, the certificate or the network that is not an answer of a push service: the host or its config is at fault
  REFUSED_LOCAL: 'refused_local'
} as const
export type PushOutcome = (typeof PushOutcomes)[keyof typeof PushOutcomes]

// The worker posts to the endpoint a browser gave the api, so an endpoint is a url the server will
// call: it is accepted only on the host of a known push service, never a host the caller chooses.
// A browser on a new push service needs its host added here.
export const PushServiceHosts = {
  EXACT: ['fcm.googleapis.com'],
  SUFFIXES: ['.push.services.mozilla.com', '.push.apple.com', '.notify.windows.com']
} as const

const HTTPS_PORT = '443'

export function isPushEndpoint(value: string): boolean {
  if (value.length > PushLimits.MAX_ENDPOINT_LENGTH) return false
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  if (url.protocol !== 'https:') return false
  if (url.username !== '' || url.password !== '') return false
  if (url.port !== '' && url.port !== HTTPS_PORT) return false
  const host = url.hostname.toLowerCase()
  const exact: readonly string[] = PushServiceHosts.EXACT
  return exact.includes(host) || PushServiceHosts.SUFFIXES.some(suffix => host.endsWith(suffix))
}

// What the service worker receives (TDD_06 §7.1). The title and body are written on the server in the
// language of the person: the worker has no catalog.
export interface PushPayload {
  notificationId: string
  title: string
  body: string
  tag: string // Same tag replaces the previous notification on the device
  severity: NotificationSeverityType
  actionPath: string | null
}

// Several notifications about one thing (one conversation) replace each other on the device; one
// without a resource stands alone
export const pushTag = (
  type: NotificationType,
  resourceId: string | null,
  notificationId: string
): string => `${type}:${resourceId ?? notificationId}`

// Cut at the limit with an ellipsis; a string within it is returned as it is
export function clipPushText(text: string, max: number): string {
  const chars = [...text]
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('')}…`
}

// base64url without padding, as PushSubscription.toJSON() and web-push write keys, of this many bytes
export function isBase64UrlOfBytes(value: string, bytes: number): boolean {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return false
  return value.length === Math.ceil((bytes * 4) / 3)
}

// web-push parses the endpoint again with its own, older parser. The url that was checked is the one
// stored and sent, written the way the checking parser reads it, so the two cannot disagree on the host.
export const normalizePushEndpoint = (value: string): string => new URL(value).href
