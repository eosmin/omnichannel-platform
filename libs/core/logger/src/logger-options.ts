import type { IncomingMessage, ServerResponse } from 'node:http'

import type { Options } from 'pino-http'

import { API_PREFIX, InfraRoutes } from '@platform/core/api'
import { isRecord, isSecretHeader, REDACTED, scrubQuery, scrubUrl } from '@platform/core/domain'

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

// How many objects may wrap a secret and still have it removed. A path of pino's redaction names its
// depth (`*` stands for exactly one level), so every depth is listed; each added level makes pino
// look at more of the logged object, which is cheap for a log line and not for a large payload.
const REDACTION_DEPTH = 4

// The path of `name` at the top level of what is logged and at each depth up to REDACTION_DEPTH
function atEveryDepth(name: string): string[] {
  return Array.from({ length: REDACTION_DEPTH + 1 }, (_, wrappers) =>
    [...Array<string>(wrappers).fill('*'), name].join('.')
  )
}

// Names that hold a secret, in the spellings the code and the providers use. Removed wherever they
// are, alone or inside a context, a result or the error of an HTTP client.
export const REDACTED_SECRET_KEYS: readonly string[] = [
  'apiKey',
  'api_key',
  'access_token',
  'refresh_token',
  'token',
  'privateKey',
  'private_key',
  'secret',
  'accessToken',
  'refreshToken',
  'password',
  'authorization',
  'client_secret',
  'clientSecret',
  'appSecret',
  'app_secret',
  'instagramAppSecret',
  'instagram_app_secret',
  'verifyToken',
  'verify_token',
  'webhookSecret',
  'webhook_secret'
]

// Never log secrets
export const REDACTED_PATHS: readonly string[] = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'req.headers["proxy-authorization"]',
  'req.headers["x-hub-signature"]',
  'req.headers["x-hub-signature-256"]',
  'req.headers["svix-signature"]',
  'req.body.password',
  'req.body.token',
  'req.body.refreshToken',
  'req.body.credentials',
  'req.body.credentials.*',
  'res.headers["set-cookie"]',
  // The callback of the login redirects with the id of a session in the address
  'res.headers.location',
  // The decrypted credentials of a connection have the keys of each provider, so the object goes
  // whole: logged alone, inside a context, or inside a result
  ...atEveryDepth('credentials'),
  ...REDACTED_SECRET_KEYS.flatMap(atEveryDepth),
  // The header of an error raised by an HTTP client carries the key of the call, a few levels down
  ...atEveryDepth('headers.Authorization'),
  ...atEveryDepth('headers.authorization')
]

// The segment that follows the invitations prefix is the secret one (see scrub-url.ts). A wildcard
// param keeps the segments of the path with Nest's global prefix already taken off.
const SECRET_SEGMENT = 'invitations'
const VERSION_SEGMENT = API_PREFIX.split('/').at(-1) // 'v1'

interface LoggedRequest {
  url?: string
  params?: Record<string, unknown>
  query?: unknown
  headers?: unknown
}

// Applied to the request after pino has serialized it (url, query, params, headers...): the path
// appears twice, as the url and, before the route is matched, as the wildcard params, and the query
// string twice too, as the tail of the url and as the parsed query
export function scrubRequest<T extends LoggedRequest>(request: T): T {
  const scrubbed: T = { ...request }
  if (typeof request.url === 'string') scrubbed.url = scrubUrl(request.url)
  if (isRecord(request.query)) scrubbed.query = scrubQuery(request.query)
  if (isRecord(request.headers)) {
    scrubbed.headers = Object.fromEntries(
      Object.entries(request.headers).map(([name, value]) => [name, scrubHeader(name, value)])
    )
  }
  if (request.params !== undefined) {
    scrubbed.params = Object.fromEntries(
      Object.entries(request.params).map(([name, value]) => [name, scrubParam(name, value)])
    )
  }
  return scrubbed
}

function scrubHeader(name: string, value: unknown): unknown {
  if (isSecretHeader(name)) return REDACTED
  // The page that called the api: its url can carry the same secrets
  return name.toLowerCase() === 'referer' && typeof value === 'string' ? scrubUrl(value) : value
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
