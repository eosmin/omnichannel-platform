import { Injectable, type NestMiddleware } from '@nestjs/common'
import type { NextFunction, Request, Response } from 'express'

import { HttpStatusCodes } from '@platform/core/errors'

const PREFLIGHT_MAX_AGE_SECONDS = 600

// The preflight of the browser, which asks before it posts from another site. It carries no site key,
// so it cannot be answered by the store's list: it is answered for the origin that asks, and grants
// nothing, because the request that follows is the one that checks the origin and says whether the
// answer may be read (see allowOrigin).
@Injectable()
export class WidgetCorsMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const origin = req.headers.origin
    if (req.method !== 'OPTIONS' || origin === undefined) {
      next()
      return
    }
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Access-Control-Allow-Methods', 'POST')
    res.setHeader('Access-Control-Allow-Headers', 'content-type')
    res.setHeader('Access-Control-Max-Age', String(PREFLIGHT_MAX_AGE_SECONDS))
    res.vary('Origin')
    res.status(HttpStatusCodes.NO_CONTENT).end()
  }
}
