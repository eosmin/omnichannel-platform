// The hosts the pictures of the channels are drawn from (the avatar of a customer and the thumbnail of a story they
// answered) are what the plugins declare, written into a committed file by `pnpm gen:image-hosts` (CI refuses a stale
// one): this file knows no channel. A plugin chose those urls, so the image is untrusted: it is drawn from these hosts only, and the
// interface falls back to initials or a notice when it fails.
// (The generated file has no imports: `next.config.ts` loads this one before the aliases exist.)
import { PLUGIN_AVATAR_IMAGE_HOSTS, PLUGIN_MEDIA_IMAGE_HOSTS } from './generated/plugin-image-hosts'

export interface ContentSecurityPolicyOptions {
  nonce: string
  apiUrl: string
  wsUrl: string
  // The bucket of the files: the browser uploads to it (PUT) and draws and plays what it signs
  storageUrl: string
  sentryDsn?: string | undefined
  isDev: boolean
}

// The websocket origin of a url that may be http(s) or already ws(s): the env schema allows only
// those four schemes, so a secure url never yields a plain ws:// source
function webSocketOrigin(url: string): string {
  const { protocol, host } = new URL(url)
  const secure = protocol === 'https:' || protocol === 'wss:'
  return `${secure ? 'wss:' : 'ws:'}//${host}`
}

// Scripts run only with the nonce of the request (Next puts it on its own scripts); styles keep
// 'unsafe-inline' because the Radix portals inject a few. Nothing here lets another site frame
// the app or load a plugin iframe: those origins join frame-src with the step that builds them.
export function buildContentSecurityPolicy(options: ContentSecurityPolicyOptions): string {
  const { nonce, apiUrl, wsUrl, storageUrl, sentryDsn, isDev } = options
  const storageOrigin = new URL(storageUrl).origin
  // A Set, because the api and the websocket share an origin in development
  const connectSources = new Set([
    "'self'",
    new URL(apiUrl).origin,
    new URL(wsUrl).origin,
    storageOrigin,
    webSocketOrigin(wsUrl),
    ...(sentryDsn ? [new URL(sentryDsn).origin] : [])
  ])
  const directives = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ''}`,
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: blob: ${storageOrigin} ${[...PLUGIN_AVATAR_IMAGE_HOSTS, ...PLUGIN_MEDIA_IMAGE_HOSTS].join(' ')}`,
    `media-src 'self' blob: ${storageOrigin}`,
    `connect-src ${[...connectSources].join(' ')}`,
    "font-src 'self'",
    "object-src 'none'",
    "frame-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "worker-src 'self'",
    "manifest-src 'self'"
  ]
  return directives.join('; ')
}

export const STATIC_SECURITY_HEADERS: ReadonlyArray<{ key: string; value: string }> = [
  { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains; preload' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Permissions-Policy', value: 'camera=(self), microphone=(), geolocation=()' }
]
