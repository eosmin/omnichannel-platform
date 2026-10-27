import type { IncomingHttpHeaders } from 'node:http'

// The address of the client of a request that did not go through Express (a websocket upgrade), by the
// same rule as Express's `trust proxy` with a number: `hops` proxies are in front of us, each added the
// address it saw to X-Forwarded-For, so the client is the entry `hops` from the right. Anything the
// client wrote itself sits further to the left and is not believed. With no proxy the header is not
// read at all.
export function clientAddress(
  headers: IncomingHttpHeaders,
  remoteAddress: string,
  hops: number
): string {
  if (hops === 0) return remoteAddress
  const forwarded = headers['x-forwarded-for']
  const chain = (Array.isArray(forwarded) ? forwarded.join(',') : (forwarded ?? ''))
    .split(',')
    .map(entry => entry.trim())
    .filter(entry => entry !== '')
  return chain[chain.length - hops] ?? remoteAddress
}
