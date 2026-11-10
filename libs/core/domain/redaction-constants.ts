// Broad on purpose: a log line that hides a harmless `state=open` costs nothing, one that shows a
// secret costs a rotation.
// Query params whose value is a secret or a one-time credential: the names an OAuth redirect, a webhook
// handshake or an API call uses (a provider's own `*_token` is caught by the suffixes below). The request log and the error
// reports keep the name and drop the value. Compared in lower case, after decoding the name.
export const SENSITIVE_QUERY_PARAMS: readonly string[] = [
  'token',
  'access_token',
  'api_key',
  'apikey',
  'key',
  'code',
  'state',
  'signature',
  'sig',
  'auth',
  'otp',
  'password',
  'pwd',
  'authorization',
  'jwt',
  'bearer',
  'session',
  // The opaque id of a login session, which the web app receives in its address (ChannelOAuthQuery.SESSION)
  'oauth',
  'sid',
  'credential',
  'credentials'
]

// A name that ends like one of these is a secret too (refresh_token, refreshToken, client_secret,
// idempotency_key), so a param nobody listed fails closed instead of reaching the log.
export const SENSITIVE_QUERY_SUFFIXES: readonly string[] = [
  'token',
  'secret',
  'password',
  'signature',
  '_key',
  '-key',
  'secretkey',
  'accesskey',
  'privatekey',
  'apikey',
  'sessionid'
]

// Headers that an error report never carries (the request log redacts the same ones). The body
// fields follow the names of SENSITIVE_QUERY_PARAMS and SENSITIVE_QUERY_SUFFIXES.
export const REPORT_REDACTED_HEADERS: readonly string[] = [
  'authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'proxy-authorization'
]

// A header that proves who sent a request, or lets whoever reads it act as them: a signature (svix,
// Stripe, Meta, a plugin's), an authorization, a cookie, a key, a token or a secret. Matched by what
// the name says, not by a list, so a provider added later is covered without anyone remembering it.
const SECRET_HEADER = /signature|authorization|cookie|api-?key|token|secret|credential|password/i

export function isSecretHeader(name: string): boolean {
  return SECRET_HEADER.test(name)
}

// The page that called the api: its url can carry the same secrets as ours
export const REFERER_HEADER = 'referer'

// Spans whose description is "<METHOD> <url>"
export const HTTP_SPAN_OP_PREFIX = 'http'

// What a plugin may declare as `redactedKeys`: names of fields that hold a secret in what it logs, which the
// core cannot guess (a provider that calls its secret `acmeSecret` is not caught by a name rule). A name, never
// a path: a dot, a wildcard or a bracket would reach into the redaction paths of the logger.
export const REDACTED_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/
export const MAX_DECLARED_REDACTED_KEYS = 32

// The names a plugin declared, checked: a list of at most MAX_DECLARED_REDACTED_KEYS names of REDACTED_KEY_PATTERN,
// without repeats. Absent is no key. Throws on anything else, so that a bad declaration fails the boot.
export function declaredRedactedKeys(declared: unknown): readonly string[] {
  if (declared === undefined) return []
  if (!Array.isArray(declared) || declared.length > MAX_DECLARED_REDACTED_KEYS) {
    throw new Error('the redacted keys of a plugin must be a short list of names')
  }
  const names: string[] = []
  for (const name of declared as unknown[]) {
    if (typeof name !== 'string' || !REDACTED_KEY_PATTERN.test(name)) {
      throw new Error('a redacted key of a plugin is not a plain name')
    }
    if (!names.includes(name)) names.push(name)
  }
  return Object.freeze(names)
}
