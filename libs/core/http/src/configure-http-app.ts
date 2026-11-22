import { type INestApplication, Logger as NestLogger, RequestMethod } from '@nestjs/common'
import type { Response } from 'express'
import { Logger } from 'nestjs-pino'

import { API_PREFIX, InfraRoutes } from '@platform/core/api'
import { ErrorCodes, type ErrorResponse, HttpStatusCodes } from '@platform/core/errors'
import { type AuthenticatedRequest, correlationIdMiddleware } from '@platform/core/logger'
import { useHttpMetrics } from '@platform/core/metrics-module'

import { carrierWebhookBodyParser } from './carrier-webhook-body-parser'
import { pluginEventsBodyParser } from './plugin-events-body-parser'
import { apiSecurityHeaders } from './security-headers'
import { PluginKeyProbeLimiter } from './throttler/plugin-key-probe-limiter'
import { webCors } from './web-cors.middleware'

function probeLimiterOf(app: INestApplication): PluginKeyProbeLimiter | undefined {
  try {
    return app.get(PluginKeyProbeLimiter, { strict: false })
  } catch {
    // An app without the throttler module (a test, a tool) has no limit to ask. Said in the log so that a refactor that drops the
    // provider from a real app does not leave the large read of the events route unbounded without anyone knowing
    new NestLogger(configureHttpApp.name).warn(
      'PluginKeyProbeLimiter is not available: the events body parser runs without the limit of the failed keys'
    )
    return undefined
  }
}

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
  // Before the app initializes, so before Nest's 100 KB parser: it takes the one route of the plugins that needs more
  // The limit of the keys that failed is asked before its large body is read; an app without the throttler module has no limit to ask
  app.use(pluginEventsBodyParser(probeLimiterOf(app)))
  // The webhook of a carrier: a body that is not JSON gets the uniform 401 and not the 400 of the parser
  app.use(carrierWebhookBodyParser())
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
