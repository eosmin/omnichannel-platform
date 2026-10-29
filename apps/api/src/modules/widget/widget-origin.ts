import type { Response } from 'express'

import { isAllowedOrigin } from '@platform/channels/web-widget'
import { ErrorCodes, HttpStatusCodes, PlatformException } from '@platform/core/errors'

import type { WidgetSite } from './widget-sites.service'

// A site may use the widget of a store only if the owner listed it. The browser's `Origin` header
// cannot be forged by a page, so this keeps another site from using a key it copied; it is not what
// keeps a script outside a browser out (the token is). Only an allowed origin is told it may read the
// answer: for another one the browser hides it.
export function allowOrigin(site: WidgetSite, origin: string | undefined, res: Response): void {
  if (origin === undefined || !isAllowedOrigin(site.allowedOrigins, origin)) {
    throw new PlatformException(
      ErrorCodes.WIDGET_ORIGIN_NOT_ALLOWED,
      'this site may not use the widget',
      HttpStatusCodes.FORBIDDEN
    )
  }
  res.setHeader('Access-Control-Allow-Origin', origin)
  res.vary('Origin')
}
