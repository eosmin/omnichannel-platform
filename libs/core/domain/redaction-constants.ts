import { MetaWebhook } from './meta-constants'

// Broad on purpose: a log line that hides a harmless `state=open` costs nothing, one that shows a
// secret costs a rotation.
// Query params whose value is a secret or a one-time credential: the handshake token of a Meta
// webhook, and the names an OAuth redirect or an API call uses. The request log and the error
// reports keep the name and drop the value. Compared in lower case, after decoding the name.
export const SENSITIVE_QUERY_PARAMS: readonly string[] = [
  MetaWebhook.VERIFY_TOKEN_PARAM,
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
  'proxy-authorization',
  MetaWebhook.SIGNATURE_HEADER,
  'x-hub-signature'
]

// The page that called the api: its url can carry the same secrets as ours
export const REFERER_HEADER = 'referer'

// Spans whose description is "<METHOD> <url>"
export const HTTP_SPAN_OP_PREFIX = 'http'
