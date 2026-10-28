import { API_PREFIX } from './api/api-prefix'
import { SENSITIVE_QUERY_PARAMS, SENSITIVE_QUERY_SUFFIXES } from './redaction-constants'

export const REDACTED = '[redacted]'

// The token of an invitation is the credential of whoever holds the link, and it travels in the path
// of GET /invitations/:token. The first segment after the prefix is the only one that names a
// secret; the id of an invitation in the team settings is not one and stays readable.
// The router takes repeated slashes as one (//api/v1/invitations/x reaches the same route), so the
// prefix is matched with any number of them
const SECRET_PATH_PREFIX = new RegExp(
  `^/+${[...API_PREFIX.split('/').filter(Boolean), 'invitations'].join('/+')}/+`,
  'i'
)

// A proxy or a client may send the absolute form of the target (http://host/path), which the
// router still matches by its path
const ORIGIN = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i
// user:password@ in front of the host of an absolute url is a credential too
const USERINFO = /^([a-z][a-z0-9+.-]*:\/\/)[^/?#@]*@/i

const SENSITIVE_QUERY_NAMES: ReadonlySet<string> = new Set(SENSITIVE_QUERY_PARAMS)
// Each pair of a query string or fragment: the separator before it, its name and its value
// A ? also ends a value, so a url passed unencoded as a value (redirect=/p?token=x) is read too
const PAIR = /(^|[?&;])([^?&;=]*)=([^?&;]*)/g
const MAX_QUERY_DEPTH = 5

// Path token and query secrets of a url, as it reaches the log or an error report
export function scrubUrl(url: string): string {
  return scrubQueryString(scrubPath(url))
}

function scrubPath(rawUrl: string): string {
  const url = rawUrl.replace(USERINFO, `$1${REDACTED}@`)
  const origin = ORIGIN.exec(url)?.[0] ?? ''
  const path = url.slice(origin.length)
  const prefix = SECRET_PATH_PREFIX.exec(path)?.[0]
  if (prefix === undefined) return url
  const rest = path.slice(prefix.length)
  const end = rest.search(/[/?#]/)
  // Nothing after the prefix (a list with a trailing slash) is not a token
  if (end === 0) return url
  return `${origin}${prefix}${REDACTED}${end === -1 ? '' : rest.slice(end)}`
}

// Keeps the names and drops the value of each sensitive param, so a line still says which params
// came. A pair after a # is not part of the request, but a tolerant parser could read it as one.
export function scrubQueryString(url: string): string {
  const hash = url.indexOf('#')
  const beforeHash = hash === -1 ? url : url.slice(0, hash)
  const fragment = hash === -1 ? '' : url.slice(hash + 1)
  const start = beforeHash.indexOf('?')
  const head = start === -1 ? beforeHash : beforeHash.slice(0, start + 1)
  const query = start === -1 ? '' : beforeHash.slice(start + 1)
  return `${head}${redactPairs(query)}${hash === -1 ? '' : `#${redactPairs(fragment)}`}`
}

// The pairs of a query string that came apart from its url, as Sentry keeps it
export function redactPairs(text: string): string {
  return text.replace(PAIR, (pair: string, separator: string, name: string, value: string) =>
    isSensitiveQueryName(name) || holdsSensitivePair(value)
      ? `${separator}${name}=${REDACTED}`
      : pair
  )
}

// A url passed percent-encoded as a value (next=%2Faccept%3Ftoken%3Dx): the value goes whole when
// what it decodes to holds a sensitive pair
function holdsSensitivePair(value: string): boolean {
  if (!value.includes('%')) return false
  try {
    const decoded = decodeURIComponent(value)
    return decoded !== value && redactPairs(decoded) !== decoded
  } catch {
    return false
  }
}

// The parsed query that pino logs next to the url; it nests when the parser builds objects from
// brackets or dots
export function scrubQuery(query: Record<string, unknown>, depth = 0): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(query).map(([name, value]) => [
      name,
      isSensitiveQueryName(name) ? REDACTED : scrubQueryValue(value, depth)
    ])
  )
}

function scrubQueryValue(value: unknown, depth: number): unknown {
  if (Array.isArray(value)) return (value as unknown[]).map(item => scrubQueryValue(item, depth))
  if (!isRecord(value)) return value
  // Deeper than any real query: fail closed
  return depth >= MAX_QUERY_DEPTH ? REDACTED : scrubQuery(value, depth + 1)
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// The name as it came: percent-decoded, in lower case, and read by every part of it, so that
// token[], filter[token] and auth.access_token all name a token
export function isSensitiveQueryName(name: string): boolean {
  const decoded = decodeName(name).toLowerCase()
  return [decoded, ...decoded.split(/[[\].]+/)].some(
    candidate =>
      candidate !== '' &&
      (SENSITIVE_QUERY_NAMES.has(candidate) ||
        SENSITIVE_QUERY_SUFFIXES.some(suffix => candidate.endsWith(suffix)))
  )
}

// A name that is not valid percent-encoding is compared as it came
function decodeName(name: string): string {
  try {
    return decodeURIComponent(name)
  } catch {
    return name
  }
}
