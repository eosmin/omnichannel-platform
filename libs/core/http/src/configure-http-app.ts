import { type INestApplication, RequestMethod } from '@nestjs/common'
import type { Response } from 'express'
import { Logger } from 'nestjs-pino'

import { API_PREFIX, InfraRoutes } from '@platform/core/api'
import { ErrorCodes, type ErrorResponse, HttpStatusCodes } from '@platform/core/errors'
import { type AuthenticatedRequest, correlationIdMiddleware } from '@platform/core/logger'
import { useHttpMetrics } from '@platform/core/metrics-module'

import { apiSecurityHeaders } from './security-headers'
import { webCors } from './web-cors.middleware'

interface Fallback {
  use: (handler: (req: AuthenticatedRequest, res: Response) => void) => void
}

// What every HTTP app of the platform shares, in the order it must run: the security headers, then
// the correlation id, so that the logs, the metrics and the error responses of a request all carry it.
// webOrigin is the one browser origin allowed to call the api (the web app); without it no browser
// origin is.
export async function configureHttpApp(
  app: INestApplication,
  { webOrigin }: { webOrigin?: string } = {}
): Promise<void> {
  app.useLogger(app.get(Logger))
  app.use(apiSecurityHeaders) // First, so that every answer has them: the 404 and the errors too
  if (webOrigin !== undefined) app.use(webCors(webOrigin))
  app.use(correlationIdMiddleware)
  useHttpMetrics(app)
  // The leading slash matters: without it Nest 12 leaves its not-found handler out and an unknown
  // route answers with Express's HTML page instead of the error contract
  app.setGlobalPrefix(API_PREFIX, {
    exclude: [InfraRoutes.healthLive, InfraRoutes.healthReady, InfraRoutes.metrics].map(path => ({
      path,
      method: RequestMethod.GET
    }))
  })

  // Nest's not-found handler only covers the prefix. Registered last, once the routes exist, this
  // one answers every other unknown path with the contract too.
  await app.init()
  const express = app.getHttpAdapter().getInstance() as Fallback
  express.use((req, res) => {
    const body: ErrorResponse = {
      error: {
        code: ErrorCodes.RESOURCE_NOT_FOUND,
        message: `Cannot ${req.method} ${req.path}`,
        metadata: {}
      },
      correlationId: req.correlationId
    }
    res.status(HttpStatusCodes.NOT_FOUND).json(body)
  })
}
