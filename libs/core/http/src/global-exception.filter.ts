import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException } from '@nestjs/common'
import type { Counter } from '@prometheus-io/client'
import * as Sentry from '@sentry/nestjs'
import type { Response } from 'express'
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino'

import { InfraRoutes } from '@platform/core/api'
import { scrubUrl } from '@platform/core/domain'
import {
  type ErrorCode,
  ErrorCodes,
  type ErrorResponse,
  HttpStatusCodes,
  PlatformException
} from '@platform/core/errors'
import type { AuthenticatedRequest } from '@platform/core/logger'
import { MetricNames } from '@platform/core/metrics'
import { InjectMetric } from '@platform/core/metrics-module'

const GENERIC_MESSAGE = 'An unexpected error occurred'
const RATE_LIMIT_MESSAGE = 'Too many requests'
// Nest writes the class in front of the message of some errors ("ThrottlerException: Too Many
// Requests"): a name of ours that the client has no use for
const CLASS_NAME_PREFIX = /^[A-Za-z]+Exception:\s*/
const INFRA_PATHS: ReadonlySet<string> = new Set([
  InfraRoutes.healthLive,
  InfraRoutes.healthReady,
  InfraRoutes.metrics
])

// The code of an error Nest raises itself (routing, pipes, throttler, body parser). Business errors
// are PlatformException and carry their own code.
const CODE_BY_STATUS: Readonly<Record<number, ErrorCode>> = {
  [HttpStatusCodes.UNAUTHORIZED]: ErrorCodes.AUTH_UNAUTHORIZED,
  [HttpStatusCodes.FORBIDDEN]: ErrorCodes.PERMISSION_DENIED,
  [HttpStatusCodes.NOT_FOUND]: ErrorCodes.RESOURCE_NOT_FOUND,
  [HttpStatusCodes.PAYLOAD_TOO_LARGE]: ErrorCodes.PAYLOAD_TOO_LARGE,
  [HttpStatusCodes.TOO_MANY_REQUESTS]: ErrorCodes.RATE_LIMIT_EXCEEDED
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// The status of each check of a failing probe, from the body Terminus raised: { database: 'down' }.
// Only the status travels. The message of a failed check names hosts and ports of the platform, and
// the probes answer on the public port of the service.
export function checksOf(response: unknown): Record<string, string> {
  if (!isRecord(response) || !isRecord(response['details'])) return {}
  return Object.fromEntries(
    Object.entries(response['details']).map(([name, check]) => [
      name,
      isRecord(check) && typeof check['status'] === 'string' ? check['status'] : 'unknown'
    ])
  )
}

// What the body parser (Express) raises when it refuses a body: an http-errors object (an Error with a
// 4xx `status` and `expose: true`), not a Nest exception. Read by shape. Its `type` names the refusal
// (too large, not JSON, an encoding or charset we do not read, an aborted upload). It never reaches the
// log whole: the error of a parse failure carries the body that was sent.
export interface BodyParserRefusal {
  status: number
  type: string
}

// The families of `type` the body parser (body-parser and raw-body) gives its errors: entity.too.large,
// entity.parse.failed, entity.verify.failed, encoding.unsupported, charset.unsupported,
// request.aborted, request.size.invalid, stream.encoding.set. Another http-errors object is not ours.
const PARSER_TYPE_FAMILIES = ['entity.', 'encoding.', 'charset.', 'request.', 'stream.'] as const

const CLIENT_ERROR_FLOOR = 400
const SERVER_ERROR_FLOOR = 500

export function bodyParserRefusal(exception: unknown): BodyParserRefusal | undefined {
  if (!(exception instanceof Error) || !isRecord(exception)) return undefined
  const { status, type, expose } = exception
  if (typeof type !== 'string' || typeof status !== 'number' || expose !== true) return undefined
  if (!PARSER_TYPE_FAMILIES.some(family => type.startsWith(family))) return undefined
  if (status < CLIENT_ERROR_FLOOR || status >= SERVER_ERROR_FLOOR) return undefined
  return { status, type }
}

// What a client is told for an error Nest raised: the message without the name of a class, and for a
// rate limit a message of ours
export function publicMessage(status: number, message: string): string {
  if (status === HttpStatusCodes.TOO_MANY_REQUESTS) return RATE_LIMIT_MESSAGE
  return message.replace(CLASS_NAME_PREFIX, '')
}

export function codeForHttpStatus(status: number): ErrorCode {
  const known = CODE_BY_STATUS[status]
  if (known !== undefined) return known
  return status >= 500 ? ErrorCodes.INTERNAL_ERROR : ErrorCodes.VALIDATION_FAILED
}

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  constructor(
    @InjectPinoLogger(GlobalExceptionFilter.name) private readonly logger: PinoLogger,
    @InjectMetric(MetricNames.TENANT_VIOLATIONS) private readonly tenantViolations: Counter<string>
  ) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const context = host.switchToHttp()
    const request = context.getRequest<AuthenticatedRequest>()
    const response = context.getResponse<Response>()
    const correlationId = request.correlationId

    // The response already started (a download that fails halfway): there is no contract left to
    // send, only the error to log and the connection to close
    if (response.headersSent) {
      this.logger.error({ err: exception }, 'error after the response started')
      response.end()
      return
    }

    // Known business errors: a warning, never reported to Sentry
    if (exception instanceof PlatformException) {
      if (exception.code === ErrorCodes.TENANT_ACCESS_DENIED) {
        this.tenantViolations.inc({ resource: this.routeOf(request) })
      }
      this.logger.warn({ code: exception.code, metadata: exception.metadata }, exception.message)
      this.send(response, exception.statusCode, {
        error: {
          code: exception.code,
          message: exception.message,
          metadata: exception.metadata ?? {}
        },
        correlationId
      })
      return
    }

    // A body the parser refused: the client's fault, answered with the status the parser chose and the
    // code of that status. Only the kind of refusal is logged, never the error (it can hold the
    // body), and the path only scrubbed (public routes carry tokens in it).
    const refusal = bodyParserRefusal(exception)
    if (refusal !== undefined) {
      this.logger.warn(
        { type: refusal.type, status: refusal.status, path: scrubUrl(request.path) },
        'request body refused by the parser'
      )
      this.send(response, refusal.status, {
        error: {
          code: codeForHttpStatus(refusal.status),
          message: 'request body refused',
          metadata: {}
        },
        correlationId
      })
      return
    }

    // Nest's own HTTP exceptions map to the same contract. A 5xx is a failure of ours: it is
    // reported and its message is not shown. The probes are the exception: they answer 503 when a
    // dependency is down, and that is their job, not an incident to page about.
    if (exception instanceof HttpException) {
      const status = exception.getStatus()
      const probe = INFRA_PATHS.has(request.path)
      const serverFailure = status >= 500 && !probe
      if (serverFailure) this.report(exception, request)
      this.send(response, status, {
        error: {
          code: codeForHttpStatus(status),
          message: serverFailure ? GENERIC_MESSAGE : publicMessage(status, exception.message),
          // A failing probe says which of its checks failed, so that whoever reads it knows where to look
          metadata: probe ? { checks: checksOf(exception.getResponse()) } : {}
        },
        correlationId
      })
      return
    }

    // Unexpected: the full report. The client only ever sees the generic message.
    this.report(exception, request)
    this.send(response, HttpStatusCodes.INTERNAL_SERVER_ERROR, {
      error: { code: ErrorCodes.INTERNAL_ERROR, message: GENERIC_MESSAGE, metadata: {} },
      correlationId
    })
  }

  private report(exception: unknown, request: AuthenticatedRequest): void {
    Sentry.withScope(scope => {
      scope.setContext('request', {
        url: scrubUrl(request.url),
        method: request.method,
        correlationId: request.correlationId
      })
      scope.setUser({ id: request.user?.id })
      scope.setTag('store_id', request.store?.id ?? 'none')
      Sentry.captureException(exception)
    })
    this.logger.error({ err: exception }, 'request failed with a server error')
  }

  private routeOf(request: AuthenticatedRequest): string {
    return (request.route as { path?: string } | undefined)?.path ?? 'unknown'
  }

  private send(response: Response, status: number, body: ErrorResponse): void {
    response.status(status).json(body)
  }
}
