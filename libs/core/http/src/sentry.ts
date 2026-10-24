import * as Sentry from '@sentry/nestjs'

export interface SentryOptions {
  dsn: string | undefined
  environment: string
  release: string | undefined
}

// Only the deployed environments report: a laptop, the tests and the CI runs must not, even when a
// DSN is in their environment
const REPORTING_ENVIRONMENTS: readonly string[] = ['staging', 'production']

// Matched ignoring the case, at any depth of the body, like the log redaction
const SCRUBBED_FIELDS: ReadonlySet<string> = new Set([
  'password',
  'token',
  'refreshtoken',
  'accesstoken',
  'apikey',
  'secret',
  'credentials',
  'authorization'
])
const SCRUBBED_HEADERS = ['authorization', 'cookie', 'x-api-key', 'proxy-authorization'] as const
const MAX_DEPTH = 8
const REMOVED = '[removed]'

// Expected business errors are already logged and are not incidents
export const SENTRY_IGNORED_ERRORS: readonly string[] = ['PlatformException', 'ThrottlerException']

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function scrubValue(value: unknown, depth: number): void {
  if (depth > MAX_DEPTH) return
  if (Array.isArray(value)) {
    for (const item of value) scrubValue(item, depth + 1)
    return
  }
  if (!isRecord(value)) return
  for (const key of Object.keys(value)) {
    if (SCRUBBED_FIELDS.has(key.toLowerCase())) value[key] = REMOVED
    else scrubValue(value[key], depth + 1)
  }
}

// Never send secrets or personal data to Sentry
export function scrubEvent<T extends Sentry.ErrorEvent>(event: T): T {
  scrubValue(event.request?.data, 0)
  const headers = event.request?.headers
  if (isRecord(headers)) {
    for (const key of Object.keys(headers)) {
      if ((SCRUBBED_HEADERS as readonly string[]).includes(key.toLowerCase()))
        headers[key] = REMOVED
    }
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
    ignoreErrors: [...SENTRY_IGNORED_ERRORS]
  })
  return true
}
