import { isPlatformHost, PluginWidgetFrames } from '@platform/core/domain'

// `frame-src` per store (TDD_05 §6, TDD_10 §7). The proxy sees a page request with no session of its own (only the
// refresh cookie, which it cannot spend), so it cannot ask the api which plugins a store has. The page does ask, on the
// agent's session, and leaves the origins it learned in a cookie named for the store; the proxy reads the cookie of the
// store in the path of the request and allows those origins to be framed, in that response only.
//
// The cookie is the browser's own and is trusted for nothing but that: the proxy keeps only well-formed https origins
// that are not ours, so a forged cookie can at most let this browser frame another site's page inside the sandbox it
// is always given. What a frame may ask of the platform is decided by the api, session by session.

const STORE_PATH = /^\/s\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/|$)/i

export function storeIdOfPath(pathname: string): string | null {
  return STORE_PATH.exec(pathname)?.[1]?.toLowerCase() ?? null
}

export function frameCookieName(storeId: string): string {
  return `${PluginWidgetFrames.COOKIE_PREFIX}${storeId.toLowerCase()}`
}

// Letters, digits, dots and hyphens in the host and an optional port, nothing else. The URL parser lets a host hold
// characters that mean something in a policy (`*`, `;`, quotes), and this value is written into a header.
const SAFE_ORIGIN = /^https:\/\/[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:[0-9]{1,5})?$/

function originOf(candidate: string): string | null {
  if (!SAFE_ORIGIN.test(candidate)) return null
  try {
    const url = new URL(candidate)
    if (url.protocol !== 'https:') return null
    if (url.username !== '' || url.password !== '') return null
    // Only a bare origin: no path, no query, no fragment; the scheme and host in their canonical form
    return url.origin === candidate ? url.origin : null
  } catch {
    return null
  }
}

// The origins a cookie value holds that are fit to join `frame-src`, at most `ORIGINS_MAX`, without repeats.
// `platformOrigins` are the web app's, the api's, the socket's and the storage's: none of them may be framed.
export function parseFrameOrigins(
  value: string | undefined,
  platformOrigins: readonly string[]
): string[] {
  if (value === undefined || value === '') return []
  const platformHosts = platformOrigins.flatMap(origin => {
    try {
      return [new URL(origin).hostname]
    } catch {
      return []
    }
  })
  const kept = new Set<string>()
  for (const part of value.split(PluginWidgetFrames.COOKIE_SEPARATOR)) {
    const origin = originOf(part)
    if (origin === null) continue
    if (isPlatformHost(new URL(origin).hostname, platformHosts)) continue
    kept.add(origin)
    if (kept.size >= PluginWidgetFrames.ORIGINS_MAX) break
  }
  return [...kept]
}

export function serializeFrameOrigins(origins: readonly string[]): string {
  return [...new Set(origins)]
    .slice(0, PluginWidgetFrames.ORIGINS_MAX)
    .join(PluginWidgetFrames.COOKIE_SEPARATOR)
}

// The same cookie value as the browser holds it: Next decodes it for the proxy, `document.cookie` does not
export function decodeCookieValue(raw: string): string {
  try {
    return decodeURIComponent(raw)
  } catch {
    return ''
  }
}
