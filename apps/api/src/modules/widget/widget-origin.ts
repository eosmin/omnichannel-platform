import type { Response } from 'express'

import { isAllowedOrigin } from '@platform/channels/web-widget'
import { ErrorCodes, HttpStatusCodes, PlatformException } from '@platform/core/errors'

import type { WidgetSite } from './widget-sites.service'

// A site may use the widget of a store only if the owner listed it. The browser's `Origin` header
// cannot be forged by a page, so this keeps another site from using a key it copied; it is not what
// keeps a script outside a browser out (the token is). Only an allowed origin is told it may read the
// answer: for another one the browser hides it.
//
// A site key that does not exist (or is malformed, or belongs to a connection that was disconnected)
// is refused with this same answer, not with a "not found": a different one would tell anybody which
// keys exist. The answer is the same in status, body and headers (no Access-Control-Allow-Origin in
// either). Timing is not made equal to the microsecond: a well-formed key costs one lookup either way,
// and a malformed one returns before any (which says nothing about whether a well-formed key exists).
// The per-IP limit of the route bounds how many keys one client can try.
export function allowOrigin(
  site: WidgetSite | null,
  origin: string | undefined,
  res: Response
): asserts site is WidgetSite {
  if (site === null || origin === undefined || !isAllowedOrigin(site.allowedOrigins, origin)) {
    throw new PlatformException(
      ErrorCodes.WIDGET_ORIGIN_NOT_ALLOWED,
      'this site may not use the widget',
      HttpStatusCodes.FORBIDDEN
    )
  }
  res.setHeader('Access-Control-Allow-Origin', origin)
  res.vary('Origin')
}
