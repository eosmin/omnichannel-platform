import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

import { isPublicAddress } from './public-address'

export class UnsafeUrlError extends Error {
  constructor(reason: string) {
    super(`the link is not safe to fetch: ${reason}`)
    this.name = 'UnsafeUrlError'
  }
}

export type HostResolver = (host: string) => Promise<string[]>

const resolveAll: HostResolver = async host =>
  (await lookup(host, { all: true, verbatim: true })).map(entry => entry.address)

// A link that came from outside (an ad, a customer, a provider) is fetched only when it is plain https
// on the default port, with no credentials, and every address its host resolves to is public. The
// answer is checked before the call; the plugin keeps its own list of hosts and does not follow
// redirects, so a host that changes its answer between the two is not followed anywhere else.
export async function assertPublicHttpsUrl(
  raw: string,
  resolve: HostResolver = resolveAll
): Promise<URL> {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new UnsafeUrlError('not a url')
  }
  if (url.protocol !== 'https:') throw new UnsafeUrlError('not https')
  if (url.username !== '' || url.password !== '') throw new UnsafeUrlError('has credentials')
  if (url.port !== '' && url.port !== '443') throw new UnsafeUrlError('not the default port')

  // `[::1]` keeps its brackets in `hostname`
  const host = url.hostname.replace(/^\[|\]$/g, '')
  const addresses = isIP(host) === 0 ? await resolve(host) : [host]
  if (addresses.length === 0 || !addresses.every(isPublicAddress)) {
    throw new UnsafeUrlError('its host is not on the public internet')
  }
  return url
}
