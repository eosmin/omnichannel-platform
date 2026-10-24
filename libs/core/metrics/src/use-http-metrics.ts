import type { INestApplication } from '@nestjs/common'
import type { NextFunction, Request, Response } from 'express'

import { HttpMetricsMiddleware } from './http-metrics.middleware'

// Mounted on the app and not through a Nest module: a module middleware takes the global prefix,
// and a request outside /api/v1 (a probe, a scan for /robots.txt) would never be counted.
export function useHttpMetrics(app: INestApplication): void {
  const middleware = app.get(HttpMetricsMiddleware)
  app.use((req: Request, res: Response, next: NextFunction) => middleware.use(req, res, next))
}
