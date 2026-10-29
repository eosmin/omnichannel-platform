// A POST of the page carries an Origin header; one from another site carries that site's. The
// handlers of the session only answer their own origin, so a form on another site cannot make the
// browser rotate or clear the cookie. A missing header is refused too: a browser always sends it
// on a POST. Host is compared, not the scheme, because behind a proxy the scheme is the proxy's;
// and the host the proxy was asked for (X-Forwarded-Host) wins over the one it rewrote.
export function isSameOrigin(
  originHeader: string | null,
  host: string | null,
  forwardedHost: string | null = null
): boolean {
  const expected = forwardedHost ?? host
  if (originHeader === null || expected === null) return false
  try {
    return new URL(originHeader).host === expected
  } catch {
    return false
  }
}
