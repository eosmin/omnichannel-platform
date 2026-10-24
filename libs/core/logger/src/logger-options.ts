import type { IncomingMessage, ServerResponse } from 'node:http'

import type { Options } from 'pino-http'

import { InfraRoutes } from '@platform/core/api'

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
  '*.apiKey',
  '*.secret',
  '*.accessToken',
  '*.refreshToken',
  '*.password',
  '*.authorization'
]

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

    autoLogging: {
      ignore: (req: IncomingMessage) => QUIET_PATHS.has((req.url ?? '').split('?')[0] ?? '')
    },

    customLogLevel: (_req: IncomingMessage, res: ServerResponse, error: Error | undefined) =>
      logLevelFor(res.statusCode, error)
  }
}
