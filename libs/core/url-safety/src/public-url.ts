import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

import { PRIVATE_TLDS } from '@platform/core/domain'

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

// What a vetted link resolves to: the url and the addresses every one of which is public
export interface PublicTarget {
  url: URL
  addresses: string[]
}

// A link that came from outside (an ad, a customer, a provider) is fetched only when it is plain https
// on the default port, with no credentials, and every address its host resolves to is public. The
// answer is checked before the call. A caller that makes the request itself must connect to one of
// the addresses returned here (`pinnedHttpsGet`), or the host could answer differently between the
// check and the call; a caller that hands the link to a plugin cannot pin it, and the plugin keeps
// its own list of hosts and follows no redirects.
export async function resolvePublicHttpsUrl(
  raw: string,
  resolve: HostResolver = resolveAll
): Promise<PublicTarget> {
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
  return { url, addresses }
}

export async function assertPublicHttpsUrl(
  raw: string,
  resolve: HostResolver = resolveAll
): Promise<URL> {
  return (await resolvePublicHttpsUrl(raw, resolve)).url
}

// The shape of a public https address, without asking the network: https, the default port, no credentials, a host
// with a dot (or a public ip literal). It is what a document that only stores an address (a manifest) can check;
// whoever calls the address checks it again with `resolvePublicHttpsUrl`, because a name can lead anywhere later.
export function isWellFormedPublicHttpsUrl(raw: string): boolean {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') return false
  if (url.port !== '' && url.port !== '443') return false
  const host = url.hostname.replace(/^\[|\]$/g, '')
  return isIP(host) === 0 ? isPublicDomainName(host) : isPublicAddress(host)
}

const DOMAIN_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i
// A top level domain: letters, or the punycode form of an international one
const TOP_LEVEL = /^(?:[a-z]{2,}|xn--[a-z0-9-]{1,59})$/i
// Names the standard keeps out of the public DNS and the channel image list leaves alone (its tests use them)
const RESERVED_TLDS: ReadonlySet<string> = new Set(['test', 'example', 'alt'])

function isPublicDomainName(host: string): boolean {
  const labels = host.split('.')
  if (labels.length < 2 || !labels.every(label => DOMAIN_LABEL.test(label))) return false
  const suffix = (labels[labels.length - 1] ?? '').toLowerCase()
  // The names that lead to a private network and never to the internet, as the image hosts of a channel are judged
  return TOP_LEVEL.test(suffix) && !PRIVATE_TLDS.has(suffix) && !RESERVED_TLDS.has(suffix)
}
