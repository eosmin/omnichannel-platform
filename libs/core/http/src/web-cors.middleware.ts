import type { NextFunction, Request, Response } from 'express'

import { TenantHeaders } from '@platform/core/auth'
import { HttpStatusCodes } from '@platform/core/errors'
import { CORRELATION_ID_HEADER } from '@platform/core/logger'

const PREFLIGHT_MAX_AGE_SECONDS = 600
const ALLOWED_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].join(', ')
const ALLOWED_HEADERS = ['authorization', 'content-type', TenantHeaders.STORE_ID].join(', ')
// What the web app may read from an answer: the id to quote to support, and when to retry a 429
const EXPOSED_HEADERS = [CORRELATION_ID_HEADER, 'retry-after'].join(', ')

// Lets the web app, and only it, call the api from the browser. The token travels in the
// Authorization header, never in a cookie, so credentials are not allowed and no other site can ride
// on a session. Any other origin falls through untouched: the widget answers its own preflight
// (WidgetCorsMiddleware) for the sites of each store.
export function webCors(webOrigin: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    res.vary('Origin') // On every answer, so a shared cache never serves one origin's answer to another
    if (req.headers.origin !== webOrigin) {
      next()
      return
    }
    res.setHeader('Access-Control-Allow-Origin', webOrigin)
    res.setHeader('Access-Control-Expose-Headers', EXPOSED_HEADERS)
    if (req.method !== 'OPTIONS') {
      next()
      return
    }
    res.setHeader('Access-Control-Allow-Methods', ALLOWED_METHODS)
    res.setHeader('Access-Control-Allow-Headers', ALLOWED_HEADERS)
    res.setHeader('Access-Control-Max-Age', String(PREFLIGHT_MAX_AGE_SECONDS))
    res.status(HttpStatusCodes.NO_CONTENT).end()
  }
}
