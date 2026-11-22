import {
  ERROR_FIELDS,
  LOGGABLE_NAMES_THAT_LOOK_SECRET,
  REDACTION_BINARY,
  REDACTION_HANDLE,
  REDACTION_MAX_TEXT,
  REDACTION_CIRCULAR,
  REDACTION_MAX_DEPTH,
  REDACTION_MAX_NODES,
  REDACTION_TRUNCATED,
  SECRET_EXACT_NAMES,
  SECRET_JWT,
  SECRET_KEY_SUFFIX,
  SECRET_NAME_FRAGMENTS,
  SECRET_PAIR_PATTERNS,
  SECRET_TEXT_PATTERNS,
  SECRET_URL_USERINFO
} from './redaction-constants'
import { REDACTED } from './scrub-url'

const normalize = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]/g, '')

const EXACT: ReadonlySet<string> = new Set(SECRET_EXACT_NAMES.map(normalize))
const EXCEPTIONS: ReadonlySet<string> = new Set(Object.keys(LOGGABLE_NAMES_THAT_LOOK_SECRET))

// True when the name of a field says it holds a secret (and it is not one of the closed exceptions)
export function isSecretName(name: string): boolean {
  const normalized = normalize(name)
  if (EXCEPTIONS.has(normalized)) return false
  return (
    EXACT.has(normalized) ||
    SECRET_KEY_SUFFIX.test(name) ||
    SECRET_NAME_FRAGMENTS.some(fragment => normalized.includes(fragment))
  )
}

// A credential that travels inside a text
export function scrubSecretText(text: string): string {
  let scrubbed = text.length > REDACTION_MAX_TEXT ? text.slice(0, REDACTION_MAX_TEXT) : text
  const cut = scrubbed.length < text.length
  for (const pattern of SECRET_TEXT_PATTERNS) {
    pattern.lastIndex = 0
    scrubbed = scrubbed.replace(pattern, (match: string, label: string) =>
      pattern.multiline ? `${label}: ${REDACTED}` : `${label} ${REDACTED}`
    )
  }
  for (const pattern of SECRET_PAIR_PATTERNS) {
    pattern.lastIndex = 0
    scrubbed = scrubbed.replace(pattern, (_match: string, name: string) =>
      name.endsWith('=') ? `${name}${REDACTED}` : `${name}"${REDACTED}"`
    )
  }
  SECRET_URL_USERINFO.lastIndex = 0
  SECRET_JWT.lastIndex = 0
  scrubbed = scrubbed
    .replace(SECRET_URL_USERINFO, (_match: string, head: string) => `${head}${REDACTED}@`)
    .replace(SECRET_JWT, REDACTED)
  return cut ? `${scrubbed}${REDACTION_TRUNCATED}` : scrubbed
}

interface Walk {
  nodes: number
  readonly path: WeakSet<object>
  // Names the plugins declared, in the normalized form: secret wherever they are
  readonly declared: ReadonlySet<string>
}

// A copy of `value` in which every field with a secret-like name is replaced by REDACTED, at any depth: objects,
// arrays, the errors of HTTP clients (their `config.headers`) and the metadata of a job. The input is never
// changed. Bounded by REDACTION_MAX_DEPTH and REDACTION_MAX_NODES; a cycle is cut, not followed.
export function redactSecrets(value: unknown, declaredNames: readonly string[] = []): unknown {
  // Logging must never raise: whatever cannot be walked (a getter that throws, a revoked proxy) is not logged
  try {
    return redactWalk(value, declaredNames)
  } catch {
    return REDACTION_TRUNCATED
  }
}

function redactWalk(value: unknown, declaredNames: readonly string[]): unknown {
  const walk: Walk = {
    nodes: 0,
    path: new WeakSet<object>(),
    declared: new Set(declaredNames.map(normalize))
  }
  return visit(value, 0, walk)
}

function visit(value: unknown, depth: number, walk: Walk): unknown {
  if (typeof value === 'string') return scrubSecretText(value)
  if (typeof value !== 'object' || value === null) return value
  if (value instanceof Date) return value
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return REDACTION_BINARY
  // Requests, sockets and streams of an HTTP client: huge, and the text of their headers is not a field
  if (isEventEmitter(value)) return REDACTION_HANDLE
  if (walk.path.has(value)) return REDACTION_CIRCULAR
  walk.nodes += 1
  if (depth >= REDACTION_MAX_DEPTH || walk.nodes > REDACTION_MAX_NODES) return REDACTION_TRUNCATED

  walk.path.add(value)
  try {
    if (!(value instanceof Error) && typeof (value as { toJSON?: unknown }).toJSON === 'function') {
      // Decimal, ObjectId, a class that says how it is written: walk what it would write
      const json = (value as { toJSON: () => unknown }).toJSON()
      if (json !== value) return visit(json, depth, walk)
    }
    if (Array.isArray(value)) return value.map(item => visit(item, depth + 1, walk))
    if (value instanceof Set) return [...value].map(item => visit(item, depth + 1, walk))
    return visitFields(entriesOf(value), depth, walk)
  } finally {
    walk.path.delete(value)
  }
}

// By shape and not by class: this file is also compiled for the browser, which has no node:events
function isEventEmitter(value: object): boolean {
  const candidate = value as { on?: unknown; emit?: unknown }
  return typeof candidate.on === 'function' && typeof candidate.emit === 'function'
}

function entriesOf(value: object): [string, unknown][] {
  if (value instanceof Map) {
    return [...value].map(([key, item]) => [String(key), item as unknown])
  }
  // The headers of fetch keep their pairs out of reach of Object.entries
  if (typeof Headers !== 'undefined' && value instanceof Headers) {
    const pairs: [string, unknown][] = []
    value.forEach((header, name) => pairs.push([name, header]))
    return pairs
  }
  const entries = Object.entries(value)
  if (value instanceof Error) {
    // message and stack are not enumerable; the rest (config, response, code, cause) is what carries secrets
    const own = new Set(entries.map(([name]) => name))
    for (const name of ERROR_FIELDS) {
      if (!own.has(name) && name in value) entries.push([name, (value as never)[name]])
    }
  }
  return entries
}

function visitFields(entries: [string, unknown][], depth: number, walk: Walk): unknown {
  // fromEntries defines each field, so a field named `__proto__` stays a field
  return Object.fromEntries(
    entries.map(([name, item]) => [
      name,
      isSecretField(name, walk) ? REDACTED : visit(item, depth + 1, walk)
    ])
  )
}

function isSecretField(name: string, walk: Walk): boolean {
  return isSecretName(name) || (walk.declared.size > 0 && walk.declared.has(normalize(name)))
}
