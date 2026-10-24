import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus
} from '@nestjs/common'
import type { Counter } from '@prometheus-io/client'
import * as Sentry from '@sentry/nestjs'
import type { Response } from 'express'
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino'

import { InfraRoutes } from '@platform/core/api'
import {
  ErrorCodes,
  type ErrorCode,
  type ErrorResponse,
  PlatformException
} from '@platform/core/errors'
import type { AuthenticatedRequest } from '@platform/core/logger'
import { MetricNames } from '@platform/core/metrics'
import { InjectMetric } from '@platform/core/metrics-module'

const GENERIC_MESSAGE = 'An unexpected error occurred'
const INFRA_PATHS: ReadonlySet<string> = new Set([
  InfraRoutes.healthLive,
  InfraRoutes.healthReady,
  InfraRoutes.metrics
])

// The code of an error Nest raises itself (routing, pipes, throttler, body parser). Business errors
// are PlatformException and carry their own code.
const CODE_BY_STATUS: Readonly<Record<number, ErrorCode>> = {
  401: ErrorCodes.AUTH_UNAUTHORIZED,
  403: ErrorCodes.PERMISSION_DENIED,
  404: ErrorCodes.RESOURCE_NOT_FOUND,
  429: ErrorCodes.RATE_LIMIT_EXCEEDED
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
          message: serverFailure ? GENERIC_MESSAGE : exception.message,
          // A failing probe says which of its checks failed, so that whoever reads it knows where to look
          metadata: probe ? { checks: checksOf(exception.getResponse()) } : {}
        },
        correlationId
      })
      return
    }

    // Unexpected: the full report. The client only ever sees the generic message.
    this.report(exception, request)
    this.send(response, HttpStatus.INTERNAL_SERVER_ERROR, {
      error: { code: ErrorCodes.INTERNAL_ERROR, message: GENERIC_MESSAGE, metadata: {} },
      correlationId
    })
  }

  private report(exception: unknown, request: AuthenticatedRequest): void {
    Sentry.withScope(scope => {
      scope.setContext('request', {
        url: request.url,
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
