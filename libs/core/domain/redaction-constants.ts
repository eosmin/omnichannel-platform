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

// --- Redaction of anything that is logged, by the name of the field (Step 7.3, S13) ---
//
// A name rule, not a list: the key is lower-cased and stripped of everything that is not a letter or a digit,
// so `apiKey`, `api_key`, `API-KEY` and `x-api-key` are the same name. A field whose name holds one of these
// fragments is secret wherever it sits, so a field added tomorrow with a secret-like name fails closed.
export const SECRET_NAME_FRAGMENTS: readonly string[] = [
  'password',
  'passwd',
  'passphrase',
  'secret',
  'token',
  'apikey',
  'authorization',
  'cookie',
  'signature',
  'credential',
  'privatekey',
  'accesskey',
  'signingkey',
  'encryptionkey',
  'sessionid',
  'bearer',
  'sessionkey',
  'keyhash',
  // The sealed blobs of the database (credentialsEncrypted, dataEncrypted, ...): ciphertext is not for a log
  'encrypted',
  'ciphertext',
  // The public key of the data request form of a store: whoever reads it can use up the caps of the public intake (Step 7.2-H1a)
  'dsrpublickey',
  // The keyed hash of the address of a person who asked for their data: a pseudonym of a personal datum, not for a log
  'emailhash',
  // The key a plugin chose for a write (it can name a customer or an order) and the hash of the request it is tied to, which derives
  // from the body: neither is for a log (Step 7.3-S4)
  'idempotencykey',
  'requesthash'
]

// Names too short to be a fragment (`sig` would hit `design`), matched whole. The names of the sensitive query
// params minus the three that are everyday words in a log line (`key`, `code`, `state`).
const NOT_SECRET_ON_THEIR_OWN: ReadonlySet<string> = new Set(['key', 'code', 'state'])
export const SECRET_EXACT_NAMES: readonly string[] = [
  ...SENSITIVE_QUERY_PARAMS.filter(name => !NOT_SECRET_ON_THEIR_OWN.has(name)),
  // Tax data of a person and the certificate of the issuer (TDD_18 §9.2, Step 4B.7b-3)
  'taxId',
  'registrationId',
  'taxpayerType',
  'economicActivity',
  'certificate'
]

// A snake or kebab name that ends in `_key` or `-key` (idempotency_key, x-signing-key). The camel spelling
// (`cacheKey`, `objectKey`) is an everyday word and is not matched; the fragments above catch its real secrets.
export const SECRET_KEY_SUFFIX = /[_-]key$/i

// The closed list of names that match a fragment and are not secrets, each with why. A field that is not here
// and looks like a secret is redacted; a name is added here only with a reason, and the test of the Prisma
// fields fails until the author of a new field either renames it or lists it. Compared in the normalized form.
export const LOGGABLE_NAMES_THAT_LOOK_SECRET: Readonly<Record<string, string>> = {
  tokencount: 'a count of tokens of a text, not a credential',
  tokensused: 'a count of tokens, not a credential',
  maxtokens: 'a limit on the tokens of a text',
  prompttokens: 'a count of tokens',
  completiontokens: 'a count of tokens',
  totaltokens: 'a count of tokens',
  inputtokens: 'a count of tokens',
  outputtokens: 'a count of tokens',
  tokenlimit: 'a limit, not a credential',
  tokentype: 'the scheme of a token (Bearer), not its value',
  tokenexpiresat: 'the date a token expires, not its value',
  tokenexpiresin: 'the seconds a token lasts, not its value',
  accesstokenexpiresat: 'the date a token expires, not its value',
  refreshtokenexpiresat: 'the date a token expires, not its value'
}

// What stands where a secret value was, or where the walk stopped
export const REDACTION_CIRCULAR = '[circular]'
export const REDACTION_TRUNCATED = '[truncated]'
export const REDACTION_BINARY = '[binary]'

// Bounds of the walk, so a large payload costs a log line a fixed amount of work
export const REDACTION_MAX_DEPTH = 10
export const REDACTION_MAX_NODES = 5000

// A credential that travels inside a string: `Authorization: Bearer abc` in the raw text of a request, or
// a `Bearer abc` in a message. The value is replaced; the scheme and the header name stay.
// A pair `"name": "value"` or `name=value` inside a string (a request body that an HTTP client kept as text, a
// query string): the name is matched by the fragments of SECRET_NAME_FRAGMENTS with an optional `_` or `-` between
// letters (api_key, private-key), the value is replaced and the name stays.
const spaced = (fragment: string): string => fragment.split('').join('[_-]?')
const FRAGMENTS_IN_TEXT = SECRET_NAME_FRAGMENTS.map(spaced).join('|')
export const SECRET_PAIR_PATTERNS: readonly RegExp[] = [
  new RegExp(
    String.raw`("[^"\\]{0,64}(?:${FRAGMENTS_IN_TEXT})[^"\\]{0,64}"\s*:\s*)"(?:[^"\\]|\\.)*"`,
    'gi'
  ),
  new RegExp(
    String.raw`((?<![\w.-])[\w.-]{0,64}?(?:${FRAGMENTS_IN_TEXT})[\w.-]{0,64}=)[^&\s"']{1,2048}`,
    'gi'
  )
]

// Strings longer than this are scrubbed up to here and cut: the patterns above cost time in proportion to the text
export const REDACTION_MAX_TEXT = 65536
// ... and the text of all the strings of one log line together
export const REDACTION_MAX_LINE_TEXT = 262144

// A password in the address of a connection (redis://:pw@host, postgres://user:pw@host/db), which the errors of the
// drivers carry in their message, and a JWT, which is a credential wherever it is written
export const SECRET_URL_USERINFO =
  /(\b[a-z][a-z0-9+.-]{0,31}:\/\/[^/\s:@]{0,128}:)[^@\s/]{1,256}@/gi
export const SECRET_JWT = /\beyJ[\w-]{8,1024}\.[\w-]{8,1024}\.[\w-]{4,1024}/g

// Own names a walk reads on an error and on the objects it skips
export const ERROR_FIELDS: readonly string[] = ['name', 'message', 'stack', 'cause']
export const SERIALIZED_LOG_KEYS: readonly string[] = ['req', 'res', 'err']
export const REDACTION_HANDLE = '[handle]'

// Text patterns, run in this order. Header lines go by the same fragments as the field names (so `x-amz-security-token`,
// `x-auth-token` and a provider's `x-foo-signature` are covered without a list), plus the names that carry no fragment.
export const SECRET_LINE_HEADERS: readonly string[] = [
  'authorization',
  'proxy-authorization',
  'x-api-key',
  'cookie',
  'set-cookie'
]
export const SECRET_TEXT_PATTERNS: readonly RegExp[] = [
  /\b(Bearer) [A-Za-z0-9._~+/=-]{8,512}/gi,
  /\b(Basic) [A-Za-z0-9+/=]{16,512}/gi,
  // a hyphen in the name is what tells a header (x-amz-security-token) from an error class (InvalidTokenError: ...)
  new RegExp(
    String.raw`^((?=\w{0,64}-)[\w-]{0,64}?(?:${FRAGMENTS_IN_TEXT})[\w-]{0,64}|${SECRET_LINE_HEADERS.join('|')})\s*:[^\r\n]*`,
    'gim'
  )
]

// The one-time and secret params of a redirect (`code`, `state`, `sig`, `key`): everyday words as the name of a
// field, so they are not redacted by name, but they are in an address or a text
export const SECRET_URL_PARAMS: readonly string[] = ['code', 'state', 'sig', 'key']
export const SECRET_URL_PARAM_PATTERN = new RegExp(
  String.raw`([?&](?:${SECRET_URL_PARAMS.join('|')})=)[^&\s#"']{1,2048}`,
  'gi'
)
