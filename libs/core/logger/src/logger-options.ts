import type { IncomingMessage, ServerResponse } from 'node:http'

import { type Logger, type LogFn, stdSerializers } from 'pino'
import type { Options } from 'pino-http'

import { API_PREFIX, InfraRoutes } from '@platform/core/api'
import {
  declaredRedactedKeys,
  isRecord,
  isSecretHeader,
  REDACTED,
  REDACTION_TRUNCATED,
  redactSecrets,
  scrubSecretText,
  scrubQuery,
  scrubUrl,
  SERIALIZED_LOG_KEYS
} from '@platform/core/domain'

import type { AuthenticatedRequest } from './authenticated-request'

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal'

export interface LoggerOptions {
  level: LogLevel
  // Human-readable output locally, JSON in every deployed environment
  pretty: boolean
  // Names of secret fields that the plugins declared (`declaredRedactedKeys` checks them), removed wherever they
  // are, like REDACTED_SECRET_KEYS. The core lists no provider's own spelling.
  redactedKeys?: readonly string[]
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

// Keys with a serializer of their own below, which already redacts them
const SERIALIZED_KEYS: ReadonlySet<string> = new Set(SERIALIZED_LOG_KEYS)

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
  'verifyToken',
  'verify_token',
  'webhookSecret',
  'webhook_secret',
  // Fiscal documents (TDD_18 §9.2): the customer data of a document and the certificate of the issuer. The provider declares the names of
  // its own credentials in its manifest, so no provider's spelling is listed here.
  'taxId',
  'tax_id',
  'registrationId',
  'registration_id',
  // The kind of taxpayer and the economic activity of a customer (Step 4B.7b-3): tax data of a person, kept out of logs like the tax id
  'taxpayerType',
  'taxpayer_type',
  'economicActivity',
  'economic_activity',
  'certificate'
]

// Never log secrets
export const REDACTED_PATHS: readonly string[] = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'req.headers["proxy-authorization"]',
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

// The paths of the core and, at every depth, the keys the plugins declared. The names are checked here too:
// a name that is a path would reach into the others
export function redactedPathsFor(declared: readonly string[]): string[] {
  return [...REDACTED_PATHS, ...declaredRedactedKeys([...declared]).flatMap(atEveryDepth)]
}

// pino's logMethod hook: the arguments of a log call, with every string scrubbed (objects go through the formatter)
export function scrubMessageArguments(
  this: Logger<never, boolean>,
  args: Parameters<LogFn>,
  method: LogFn
): void {
  const scrubbed = args.map(argument =>
    typeof argument === 'string' ? scrubSecretText(argument) : argument
  ) as Parameters<LogFn>
  method.apply(this, scrubbed)
}

// pino-http hands over an error it has already serialized; a bare pino hands over the Error itself
function serializeError(error: unknown): unknown {
  return error instanceof Error ? stdSerializers.err(error) : error
}

// The keys a pino serializer handles are left to it (it redacts them itself); the rest of the object is walked
function redactLogObject(
  object: Record<string, unknown>,
  declared: readonly string[]
): Record<string, unknown> {
  try {
    const rest = Object.fromEntries(
      Object.entries(object).filter(([name]) => !SERIALIZED_KEYS.has(name))
    )
    const walked = redactSecrets(rest, declared)
    if (typeof walked === 'object' && walked !== null) {
      return { ...object, ...(walked as Record<string, unknown>) }
    }
  } catch {
    // Object.entries runs the getters of the object: one that throws lands here
  }
  // A walk that failed: the fields are not logged (Object.keys runs no getter), failing closed and never raising
  return Object.fromEntries(
    Object.keys(object).map(name => [
      name,
      SERIALIZED_KEYS.has(name) ? undefined : REDACTION_TRUNCATED
    ])
  )
}

export function buildPinoHttpOptions({
  level,
  redactedKeys = []
}: Pick<LoggerOptions, 'level' | 'redactedKeys'>): Options {
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

    // Two layers. The paths are exact and cheap, and pino removes what they name. The walk below catches the rest
    // by the NAME of a field (password, secret, token, apiKey, cookie, signature, ... in any spelling, at any
    // depth), so a secret nobody listed fails closed: what is logged alone or in a context (`formatters.log`),
    // the request and response, and the error of an HTTP client with its `config.headers` (the serializers).
    redact: { paths: redactedPathsFor(redactedKeys), remove: true },
    // The text of a message (`logger.error({ ... }, text)`, `logger.error(text)`) is not a field: the formatter never
    // sees it, so every string argument goes through the text scrubber (a `${error.message}` that carries an address)
    hooks: { logMethod: scrubMessageArguments },
    formatters: { log: (object: Record<string, unknown>) => redactLogObject(object, redactedKeys) },
    serializers: {
      req: (request: LoggedRequest) => redactSecrets(scrubRequest(request), redactedKeys),
      res: (response: unknown) => redactSecrets(response, redactedKeys),
      err: (error: unknown) => redactSecrets(serializeError(error), redactedKeys)
    },

    autoLogging: {
      ignore: (req: IncomingMessage) => QUIET_PATHS.has((req.url ?? '').split('?')[0] ?? '')
    },

    customLogLevel: (_req: IncomingMessage, res: ServerResponse, error: Error | undefined) =>
      logLevelFor(res.statusCode, error)
  }
}
