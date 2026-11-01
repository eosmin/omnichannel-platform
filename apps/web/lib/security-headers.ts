// The hosts that serve the avatars that Meta hands over for Instagram and Messenger customers
// (CustomerIdentity.avatarUrl). A plugin chose that url, so the image is untrusted: it is drawn
// from these hosts only, and the interface falls back to initials when it fails.
export const CUSTOMER_AVATAR_IMAGE_HOSTS = [
  'https://*.fbcdn.net',
  'https://*.cdninstagram.com',
  // The signed profile pictures of Messenger. Exact host: other *.fbsbx.com hosts (apps.fbsbx.com)
  // serve content of third parties (META_MEDIA in libs/core/domain/meta-constants.ts)
  'https://platform-lookaside.fbsbx.com'
] as const

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
    `img-src 'self' data: blob: ${storageOrigin} ${CUSTOMER_AVATAR_IMAGE_HOSTS.join(' ')}`,
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
