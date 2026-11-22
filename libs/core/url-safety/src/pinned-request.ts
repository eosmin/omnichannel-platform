import { Agent, request as httpsRequest } from 'node:https'
import { isIP } from 'node:net'

import { pinnedLookup } from './pinned-lookup'
import type { PublicTarget } from './public-url'

export type HttpsRequester = typeof httpsRequest

const HTTPS_PORT = 443

export interface PinnedRequestSpec {
  method: string
  // The port of the address; https by default
  port?: number
  headers: Readonly<Record<string, string | number>>
  // The socket timeout, which restarts with every byte: the caller bounds the whole exchange with a deadline of its own
  timeoutMs: number
  // Replaceable so that a unit test needs no network
  request?: HttpsRequester | undefined
}

// The one recipe of a request to an address that came from outside (a webhook, a plugin, a link of an ad): plain https to the
// public address already checked (`PublicTarget`), a socket of its own that connects ONLY to the addresses that check read, and the
// certificate judged against the name and not against the address connected to. A redirect is never followed because nothing here
// does: the caller sees the status. It throws when Node refuses the request (a line break in a header value).
export function openPinnedRequest(
  target: PublicTarget,
  spec: PinnedRequestSpec
): ReturnType<HttpsRequester> {
  const { url, addresses } = target
  const host = url.hostname.replace(/^\[|\]$/g, '')
  const send = spec.request ?? httpsRequest
  return send({
    protocol: 'https:',
    hostname: host,
    port: spec.port ?? HTTPS_PORT,
    path: `${url.pathname}${url.search}`,
    method: spec.method,
    headers: { ...spec.headers },
    // A socket of its own: a pooled one, opened for an earlier call, would not go through this lookup
    agent: new Agent({ keepAlive: false }),
    lookup: pinnedLookup(addresses),
    // The certificate is checked against the name of the address, not the address connected to
    ...(isIP(host) === 0 ? { servername: host } : {}),
    timeout: spec.timeoutMs
  })
}
