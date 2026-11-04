// Text that came from a provider or a plugin, made safe to keep and show: one line, no control
// or invisible ones that mislead (a right-to-left override can reorder a message, a zero-width space
// hides), cut to a size. The joiners (U+200C, U+200D) stay: names in several scripts and emoji need them. It says what went wrong; it is never trusted as markup or as a command.
//
// `providerText` is for any text (a name, a template, a language). `providerErrorText` is for the
// reason a provider gives for a failure, which may repeat a credential back: it also replaces what looks
// like one. Names do not go through the second, because a template called `reset_token=v2` is a name.

export const PROVIDER_TEXT_REDACTED = '[redacted]'

// Characters that mislead or hide. The joiners are not here: `providerText` keeps them.
const HIDDEN_SOURCE = String.raw`\u200B\u200E\u200F\u202A-\u202E\u2060-\u2069\uFEFF`
// Names whose value is a credential whatever it looks like
const STRONG_NAME = String.raw`(?:access[_-]?token|refresh[_-]?token|id[_-]?token|session[_-]?token|auth[_-]?token|csrf[_-]?token|xsrf[_-]?token|security[_-]?token|verify[_-]?token|bot[_-]?token|oauth[_-]?token|client[_-]?secret|app[_-]?secret|consumer[_-]?secret|signing[_-]?secret|webhook[_-]?secret|secret[_-]?(?:access[_-]?)?key|private[_-]?key|api[_-]?key|auth[_-]?key|access[_-]?key|password|passwd|session[_-]?id|cookie)`
// Common words: after `=` they hold a credential, after `:` only a value that looks like one
const WEAK_NAME = String.raw`(?:token|secret)`
// A quote after the name, plain or escaped (a JSON body inside a JSON string), and an escaped one before the value
const NAME_QUOTE = String.raw`(?:\\*["'])?`
// An escaped quoted value runs to the next backslash: `\"abc 123\"`
const ESCAPED_VALUE = String.raw`\\+["'][^\\]*`
const SEPARATOR = String.raw`(?:[:=]|%3[AaDd])`
// A closed quoted value (it may hold spaces and escaped quotes), or everything up to a space, a comma, an
// ampersand or a closing bracket. An unterminated quote takes the rest of the text, whatever it holds: nothing of the value is left behind.
const VALUE = String.raw`"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|["'][\s\S]*$|[^\s,&)}\\]+`

// There is no prefix before the name (the name is kept as it came, and a prefix made the match quadratic
// on a long run of letters)
const named = (name: string): RegExp =>
  new RegExp(
    String.raw`(${name}${NAME_QUOTE}[ \t]*)(${SEPARATOR})([ \t]*)(${ESCAPED_VALUE}|${VALUE})`,
    'gi'
  )
const STRONG = named(STRONG_NAME)
// A signature proves who sent a request; its value runs to a space, an ampersand or a quote, commas
// included (`v1,abc` of svix, `t=1,v1=abc` of Stripe). The hash may follow the name (`-256`).
// `sig` is the one of a shared access signature, and only as a word of its own.
const SIGNATURE = new RegExp(
  String.raw`((?:signature|\bsig)(?:[_-]?\d+)?${NAME_QUOTE}[ \t]*)(${SEPARATOR})([ \t]*)("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s&"'\\)}]+)`,
  'gi'
)
const WEAK = named(WEAK_NAME)
// The whole header value, whatever the scheme and however many parts it has (`AWS4-HMAC-SHA256
// Credential=..., Signature=...`, `Digest username=..., response=...`): up to a closing quote or bracket
const AUTHORIZATION = new RegExp(
  String.raw`(authorization${NAME_QUOTE}[ \t]*${SEPARATOR}[ \t]*(?:\\*["'])?)[^"'\\)}]+`,
  'gi'
)
// The password of an address with credentials in it: https://user:password@host
const USERINFO = /(\/\/[^\s/:@]+:)[^\s/]*@/g
// A name alone before the host can be a key (`https://<key>@host`): it goes whole
const USERINFO_NAME_ONLY = /(\/\/)[^\s/:@]+@/g
// The scheme words that announce a credential. A word that follows in plain letters ("Bearer token",
// "Basic plan") is prose and stays.
const BEARER = /\b(Bearer|Basic|Digest|Negotiate|ApiKey|Api-Key)\s+([^\s,;"'\\)}]+)/gi
// Shapes that are a credential by themselves: a JWT, a Meta access token
const JWT = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g
const META_TOKEN = /\bEAA[A-Za-z0-9]{20,}/g
// Keys that carry the name of their issuer: they are a credential wherever they appear
const KNOWN_KEYS: readonly RegExp[] = [
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, // AWS access key id
  /\b[sr]k_(?:live|test)_[A-Za-z0-9]{10,}/g, // Stripe secret and restricted keys
  /\bwhsec_[A-Za-z0-9+/=]{10,}/g, // Stripe webhook signing secret
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g, // Slack
  /\bgh[pousr]_[A-Za-z0-9]{30,}/g, // GitHub
  /\bgithub_pat_[A-Za-z0-9_]{30,}/g,
  /\bAIza[A-Za-z0-9_-]{30,}/g, // Google API key
  /\bIG[A-Z]{1,3}[A-Za-z0-9_-]{30,}/g, // Instagram access token
  /\bsk-[A-Za-z0-9_-]{20,}/g, // an API key of the sk- family
  /\bbot\d{6,}:[A-Za-z0-9_-]{30,}/g, // Telegram bot token
  /\b[A-Fa-f0-9]{40,}\b/g, // a long hex string: a key, a signature, a hash of a secret
  /(hooks\.slack\.com\/services\/)[A-Za-z0-9/_-]+/g // the address is the secret
]
// A private key pasted whole, or cut where the text was
const PRIVATE_KEY_BLOCK =
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g

// A bare `token:` or `secret:` followed by prose ("token: expired") is not a credential; one followed by
// a long value with a digit in it is. A short token after a colon is therefore kept (known limit, in the plan).
const MIN_WEAK_COLON_LENGTH = 16
const looksLikeCredential = (value: string): boolean =>
  value.length >= MIN_WEAK_COLON_LENGTH && /\d/.test(value)
const unquoted = (value: string): string => value.replace(/^["']|["']$/g, '')
// "Bearer token" and "Bearer missing" are prose; a value with a digit or a symbol, or a long one, is a credential
const BEARER_PROSE_MAX_LENGTH = 19
// A capital that follows a small letter ("dXNlcjpwYXNz", the base64 of "user:pass") is not a word
const bearerIsProse = (value: string): boolean =>
  value.length <= BEARER_PROSE_MAX_LENGTH && /^[A-Za-z]+$/.test(value) && !/[a-z][A-Z]/.test(value)

// Redaction reads at most this many characters; what lies beyond is cut anyway
const REDACTION_WINDOW_FACTOR = 8
const REDACTION_WINDOW_MIN = 4096

// Only for text that `providerErrorText` has cleaned: it relies on the hidden characters being gone
function redactSecrets(text: string): string {
  const withKnownKeys = KNOWN_KEYS.reduce(
    (current, shape) =>
      current.replace(shape, (match, prefix: unknown) =>
        typeof prefix === 'string' ? `${prefix}${PROVIDER_TEXT_REDACTED}` : PROVIDER_TEXT_REDACTED
      ),
    text.replace(PRIVATE_KEY_BLOCK, PROVIDER_TEXT_REDACTED)
  )
  return withKnownKeys
    .replace(AUTHORIZATION, `$1${PROVIDER_TEXT_REDACTED}`)
    .replace(BEARER, (match, word: string, value: string) =>
      bearerIsProse(value) ? match : `${word} ${PROVIDER_TEXT_REDACTED}`
    )
    .replace(USERINFO, `$1${PROVIDER_TEXT_REDACTED}@`)
    .replace(USERINFO_NAME_ONLY, `$1${PROVIDER_TEXT_REDACTED}@`)
    .replace(JWT, PROVIDER_TEXT_REDACTED)
    .replace(META_TOKEN, PROVIDER_TEXT_REDACTED)
    .replace(
      SIGNATURE,
      (_match, name: string, sep: string, space: string) =>
        `${name}${sep}${space}${PROVIDER_TEXT_REDACTED}`
    )
    .replace(
      STRONG,
      (_match, name: string, sep: string, space: string) =>
        `${name}${sep}${space}${PROVIDER_TEXT_REDACTED}`
    )
    .replace(WEAK, (match, name: string, sep: string, space: string, value: string) =>
      sep === ':' && !looksLikeCredential(unquoted(value))
        ? match
        : `${name}${sep}${space}${PROVIDER_TEXT_REDACTED}`
    )
}

const HIDDEN = new RegExp(`[\\p{Cc}\\p{Zl}\\p{Zp}${HIDDEN_SOURCE}]+`, 'gu')
// What `providerErrorText` also removes, because inside the name of a credential they split it: the
// joiners, the soft hyphen, the other format characters, the fillers and the variation selectors
const SPLITTING = new RegExp(
  String.raw`(?:\p{Cf}|\p{Variation_Selector}|\u034F|\u115F|\u1160|\u17B4|\u17B5|\u180E|\u2800|\u3164|[${HIDDEN_SOURCE}])+`,
  'gu'
)

function clean(text: string): string {
  return text.replace(HIDDEN, ' ').replace(/\s+/g, ' ').trim()
}

export function providerText(text: string, max: number): string {
  return Array.from(clean(text)).slice(0, max).join('')
}

// The invisible characters are removed here, not turned into a space as `providerText` does: one inside
// a name or a value must not split it. Then the text is cleaned and redacted once. The string is cut to
// the window before it is split into characters, so a huge message costs no more than a small one.
export function providerErrorText(text: string, max: number): string {
  const window = Math.max(max * REDACTION_WINDOW_FACTOR, REDACTION_WINDOW_MIN)
  const raw = Array.from(text.slice(0, window * 2))
    .slice(0, window)
    .join('')
    .replace(SPLITTING, '')
  return Array.from(redactSecrets(clean(raw)))
    .slice(0, max)
    .join('')
}
