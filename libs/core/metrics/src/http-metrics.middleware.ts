import { Injectable, type NestMiddleware } from '@nestjs/common'
import type { Counter, Histogram } from '@prometheus-io/client'
import type { NextFunction, Request, Response } from 'express'

import { InfraRoutes } from '@platform/core/api'
import { MetricNames } from '@platform/core/metrics'

import { InjectMetric } from './metric-tokens'

const UNMATCHED_ROUTE = 'unmatched'
const ABORTED_STATUS = 'aborted'
const NOT_COUNTED: ReadonlySet<string> = new Set([
  InfraRoutes.healthLive,
  InfraRoutes.healthReady,
  InfraRoutes.metrics
])

// Counts every request that reaches the app, the ones that match no route included. The route
// label is the route pattern ("/conversations/:id"), never the URL: a URL carries ids.
@Injectable()
export class HttpMetricsMiddleware implements NestMiddleware {
  constructor(
    @InjectMetric(MetricNames.HTTP_REQUESTS_TOTAL) private readonly requests: Counter<string>,
    @InjectMetric(MetricNames.HTTP_REQUEST_DURATION) private readonly duration: Histogram<string>
  ) {}

  use(req: Request, res: Response, next: NextFunction): void {
    const startedAt = process.hrtime.bigint()
    // 'close' follows 'finish' on a normal response and comes alone when the client gives up
    // first (a timeout, a cancelled download, a load balancer cutting a long request)
    res.on('close', () => {
      const route = (req.route as { path?: string } | undefined)?.path
      if (route !== undefined && NOT_COUNTED.has(route)) return
      const labels = {
        method: req.method,
        route: route === undefined ? UNMATCHED_ROUTE : `${req.baseUrl}${route}`,
        status_code: res.writableFinished ? String(res.statusCode) : ABORTED_STATUS
      }
      this.requests.inc(labels)
      this.duration.observe(labels, Number(process.hrtime.bigint() - startedAt) / 1e9)
    })
    next()
  }
}
