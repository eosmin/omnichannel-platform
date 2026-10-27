import type { IncomingMessage, ServerResponse } from 'node:http'

import type { Options } from 'pino-http'

import { API_PREFIX, InfraRoutes } from '@platform/core/api'

import type { AuthenticatedRequest } from './authenticated-request'

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal'

export interface LoggerOptions {
  level: LogLevel
  // Human-readable output locally, JSON in every deployed environment
  pretty: boolean
}

// Probes and scrapes live outside the /api/v1 prefix and would drown the log
const QUIET_PATHS: ReadonlySet<string> = new Set([
  InfraRoutes.healthLive,
  InfraRoutes.healthReady,
  InfraRoutes.metrics
])

// Never log secrets
export const REDACTED_PATHS: readonly string[] = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'req.headers["proxy-authorization"]',
  'req.headers["x-hub-signature"]',
  'req.headers["x-hub-signature-256"]',
  'req.body.password',
  'req.body.token',
  'req.body.refreshToken',
  'req.body.credentials',
  'req.body.credentials.*',
  'res.headers["set-cookie"]',
  // The decrypted credentials of a connection have the keys of each provider, so the object goes
  // whole: logged alone, inside a context, or inside a result
  'credentials',
  '*.credentials',
  '*.*.credentials',
  '*.*.*.credentials',
  '*.apiKey',
  '*.secret',
  '*.accessToken',
  '*.refreshToken',
  '*.password',
  '*.authorization',
  // The header of an error raised by an HTTP client carries the key of the call, a few levels down
  '*.headers.Authorization',
  '*.headers.authorization',
  '*.*.headers.Authorization',
  '*.*.headers.authorization',
  '*.*.*.headers.Authorization',
  '*.*.*.headers.authorization'
]

// The token of an invitation is the credential of whoever holds the link, and it travels in the path
// of GET /invitations/:token. The first segment after the prefix is the only one that names a
// secret; the id of an invitation in the team settings is not one and stays readable.
const SECRET_PATH_PREFIX = `${API_PREFIX}/invitations/`.toLowerCase()
const SECRET_SEGMENT = 'invitations'
const VERSION_SEGMENT = API_PREFIX.split('/').at(-1) // 'v1'
const REDACTED = '[redacted]'

interface LoggedRequest {
  url?: string
  params?: Record<string, unknown>
}

// Applied to the request after pino has serialized it (url, params, headers...): the path appears
// twice, as the url and, before the route is matched, as the wildcard params
export function scrubRequest<T extends LoggedRequest>(request: T): T {
  const scrubbed: T = { ...request }
  if (typeof request.url === 'string' && request.url.toLowerCase().startsWith(SECRET_PATH_PREFIX)) {
    const rest = request.url.slice(SECRET_PATH_PREFIX.length)
    const end = rest.search(/[/?#]/)
    scrubbed.url = `${request.url.slice(0, SECRET_PATH_PREFIX.length)}${REDACTED}${end === -1 ? '' : rest.slice(end)}`
  }
  if (request.params !== undefined) {
    scrubbed.params = Object.fromEntries(
      Object.entries(request.params).map(([name, value]) => [name, scrubParam(name, value)])
    )
  }
  return scrubbed
}

function scrubParam(name: string, value: unknown): unknown {
  if (name === 'token') return REDACTED
  if (!Array.isArray(value)) return value
  // A wildcard keeps the segments of the path, and Nest has already taken the global prefix off:
  // ['invitations', <token>, ...]. The router ignores the case, so this does too.
  const segments = value as unknown[]
  const start = segments.findIndex(
    (segment, index) =>
      isSegment(segment, SECRET_SEGMENT) &&
      (index === 0 || (index === 2 && isSegment(segments[1], VERSION_SEGMENT)))
  )
  return start === -1
    ? value
    : segments.map((segment, index) => (index === start + 1 ? REDACTED : segment))
}

function isSegment(segment: unknown, expected: string | undefined): boolean {
  return typeof segment === 'string' && segment.toLowerCase() === expected
}

export function logLevelFor(statusCode: number, error: Error | undefined): LogLevel {
  if (statusCode >= 500 || error !== undefined) return 'error'
  if (statusCode >= 400) return 'warn'
  return 'info'
}

export function buildPinoHttpOptions({ level }: Pick<LoggerOptions, 'level'>): Options {
  return {
    level,

    // Every log line carries the request context
    customProps: (req: IncomingMessage) => {
      const request = req as AuthenticatedRequest
      return {
        correlationId: request.correlationId,
        userId: request.user?.id,
        storeId: request.store?.id,
        organizationId: request.organization?.id
      }
    },

    redact: { paths: [...REDACTED_PATHS], remove: true },
    serializers: { req: scrubRequest },

    autoLogging: {
      ignore: (req: IncomingMessage) => QUIET_PATHS.has((req.url ?? '').split('?')[0] ?? '')
    },

    customLogLevel: (_req: IncomingMessage, res: ServerResponse, error: Error | undefined) =>
      logLevelFor(res.statusCode, error)
  }
}
