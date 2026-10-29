import { randomBytes } from 'node:crypto'

import { z } from 'zod'

import { WidgetLimits } from '@platform/core/domain'

// The base64url of the random bytes: 4 characters for every 3 bytes, with no padding
const SITE_KEY_RANDOM_LENGTH = Math.ceil((WidgetLimits.SITE_KEY_BYTES * 4) / 3)
const SITE_KEY_PATTERN = new RegExp(
  `^${WidgetLimits.SITE_KEY_PREFIX}[A-Za-z0-9_-]{${SITE_KEY_RANDOM_LENGTH}}$`
)

// The public id of a connection, which goes into the snippet of the store
export function newSiteKey(): string {
  return `${WidgetLimits.SITE_KEY_PREFIX}${randomBytes(WidgetLimits.SITE_KEY_BYTES).toString('base64url')}`
}

export function isSiteKey(value: unknown): value is string {
  return typeof value === 'string' && SITE_KEY_PATTERN.test(value)
}

// An origin is scheme, host and port, nothing else (what a browser sends in `Origin`). Only the web:
// anything else cannot be a site that loads the widget.
export function originOf(value: string): string | null {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  // Plain http only for a machine of the developer: the token would travel in the clear otherwise
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1'
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) return null
  // `new URL` reads a bare `?` or `#` as empty, so the text is looked at too
  if (value.includes('?') || value.includes('#')) return null
  // `https://shop.test/path` is a page, not an origin: the owner meant the site, and the path would
  // be silently dropped. A trailing slash is the same origin.
  if (url.username || url.password || url.search || url.hash) return null
  if (url.pathname !== '/') return null
  return url.origin
}

// The sites that may load the widget, as the owner typed them: each one a valid origin, no repeats
export const siteOriginsSchema = z
  .array(z.string().max(WidgetLimits.MAX_ORIGIN_LENGTH))
  .min(1)
  .max(WidgetLimits.MAX_ORIGINS)
  .transform((values, ctx) => {
    const origins = new Set<string>()
    for (const value of values) {
      const origin = originOf(value)
      if (origin === null) {
        ctx.addIssue({ code: 'custom', message: 'not an origin' })
        return z.NEVER
      }
      origins.add(origin)
    }
    return [...origins]
  })

// Whether a browser's `Origin` is one of the stored ones. A request with no origin (not a browser)
// is not allowed to claim a site.
export function isAllowedOrigin(allowed: readonly string[], origin: string | undefined): boolean {
  return origin !== undefined && allowed.includes(origin)
}
