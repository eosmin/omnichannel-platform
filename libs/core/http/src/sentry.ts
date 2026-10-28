import * as Sentry from '@sentry/nestjs'

import {
  HTTP_SPAN_OP_PREFIX,
  isRecord,
  isSensitiveQueryName,
  REDACTED,
  redactPairs,
  REFERER_HEADER,
  REPORT_REDACTED_HEADERS,
  scrubQuery,
  scrubUrl
} from '@platform/core/domain'

export interface SentryOptions {
  dsn: string | undefined
  environment: string
  release: string | undefined
}

// Only the deployed environments report: a laptop, the tests and the CI runs must not, even when a
// DSN is in their environment
const REPORTING_ENVIRONMENTS: readonly string[] = ['staging', 'production']

const MAX_DEPTH = 8

// Expected business errors are already logged and are not incidents
export const SENTRY_IGNORED_ERRORS: readonly string[] = ['PlatformException', 'ThrottlerException']

// The body of a request: an object is walked with the rule of the query names, at any depth, and
// what lies deeper than MAX_DEPTH goes whole. A text body is read as JSON, or as key=value pairs.
function scrubBody(body: unknown): unknown {
  if (typeof body !== 'string') return scrubValue(body, 0)
  try {
    return JSON.stringify(scrubValue(JSON.parse(body) as unknown, 0))
  } catch {
    return redactPairs(body)
  }
}

function scrubValue(value: unknown, depth: number): unknown {
  if (Array.isArray(value)) {
    return depth >= MAX_DEPTH
      ? REDACTED
      : (value as unknown[]).map(item => scrubValue(item, depth + 1))
  }
  if (!isRecord(value)) return value
  if (depth >= MAX_DEPTH) return REDACTED
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      isSensitiveQueryName(key) ? REDACTED : scrubValue(item, depth + 1)
    ])
  )
}

// Sentry captures the url and the query string of the request on its own, and a secret travels in
// both (the handshake token of a webhook, the token of an invitation). The breadcrumbs and the
// spans of a trace keep the same urls in their data.
function scrubRequestUrl(request: Sentry.Event['request']): void {
  if (!isRecord(request)) return
  if (typeof request.url === 'string') request.url = scrubUrl(request.url)
  const query = request.query_string
  if (typeof query === 'string') {
    request.query_string = redactPairs(query)
  } else if (Array.isArray(query)) {
    request.query_string = (query as [string, string][]).map(([name, value]): [string, string] => [
      name,
      isSensitiveQueryName(name) ? REDACTED : value
    ])
  } else if (isRecord(query)) {
    request.query_string = scrubQuery(query)
  }
}

// A key that holds a url or a path with its query, a query alone or a fragment alone. A database
// span has keys of its own (db.query.text) that are not urls.
const TRACE_URL_KEYS = /^(?!db\.).*(url|target|path|query|fragment)/i
// The query or the fragment alone has no path before it, even if a value of it holds a slash
const TRACE_PAIR_KEYS = /query|fragment/i

function scrubTraceData(data: unknown): void {
  if (!isRecord(data)) return
  for (const [key, value] of Object.entries(data)) {
    if (typeof value !== 'string' || !TRACE_URL_KEYS.test(key)) continue
    data[key] = TRACE_PAIR_KEYS.test(key) ? redactPairs(value) : scrubUrl(value)
  }
}

// The description of an http span is "GET <url>": each word may be a path or a url
function scrubDescription(description: string): string {
  return description.replace(/\S+/g, word => scrubUrl(word))
}

function scrubSpan(span: unknown): void {
  if (!isRecord(span)) return
  scrubTraceData(span['data'])
  const op = span['op']
  const description = span['description']
  if (
    typeof description === 'string' &&
    typeof op === 'string' &&
    op.startsWith(HTTP_SPAN_OP_PREFIX)
  )
    span['description'] = scrubDescription(description)
}

// The message of an error can hold a url (a client error that shows the call that failed)
function scrubMessages(event: Sentry.Event): void {
  if (typeof event.message === 'string') event.message = scrubDescription(event.message)
  for (const exception of event.exception?.values ?? []) {
    if (isRecord(exception) && typeof exception.value === 'string')
      exception.value = scrubDescription(exception.value)
  }
}

function scrubEventUrls(event: Sentry.Event): void {
  scrubRequestUrl(event.request)
  scrubTraceData(event.contexts?.['trace']?.data)
  for (const breadcrumb of event.breadcrumbs ?? [])
    if (isRecord(breadcrumb)) scrubTraceData(breadcrumb.data)
  for (const span of event.spans ?? []) scrubSpan(span)
  scrubMessages(event)
}

function scrubHeaders(headers: unknown): void {
  if (!isRecord(headers)) return
  for (const key of Object.keys(headers)) {
    const name = key.toLowerCase()
    if (REPORT_REDACTED_HEADERS.includes(name)) headers[key] = REDACTED
    else if (name === REFERER_HEADER && typeof headers[key] === 'string')
      headers[key] = scrubUrl(headers[key])
  }
}

// Never send secrets or personal data to Sentry. Both hooks run it: a transaction (one request in
// ten) carries the same headers, body and urls as an error. A throw inside a hook drops the whole
// event, so a shape nobody foresaw sends the event without what could not be cleaned.
export function scrubEvent<T extends Sentry.Event>(event: T): T {
  try {
    if (isRecord(event.request)) {
      event.request.data = scrubBody(event.request.data)
      if (event.request.cookies !== undefined) event.request.cookies = { [REDACTED]: REDACTED }
      scrubHeaders(event.request.headers)
    }
    scrubEventUrls(event)
  } catch {
    delete event.request
    delete event.breadcrumbs
    delete event.spans
    delete event.exception
    delete event.message
  }
  return event
}

// Called first thing by the instrument file of each app
export function initSentry({ dsn, environment, release }: SentryOptions): boolean {
  if (dsn === undefined || !REPORTING_ENVIRONMENTS.includes(environment)) return false
  Sentry.init({
    dsn,
    environment,
    ...(release !== undefined && { release }),
    tracesSampleRate: 0.1,
    beforeSend: scrubEvent,
    beforeSendTransaction: scrubEvent,
    ignoreErrors: [...SENTRY_IGNORED_ERRORS]
  })
  return true
}
