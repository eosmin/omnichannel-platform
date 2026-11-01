import { Agent, request as httpsRequest, type RequestOptions } from 'node:https'
import { isIP } from 'node:net'
import type { Readable } from 'node:stream'

import {
  type HostResolver,
  type PublicTarget,
  resolvePublicHttpsUrl,
  UnsafeUrlError
} from './public-url'

// The answer was not a file we can keep. `retryable` says whether asking again may help: a server error
// or a slow answer may pass, a 404 or a redirect will not.
export class PinnedFetchFailed extends Error {
  constructor(
    reason: string,
    readonly retryable: boolean
  ) {
    super(`the fetch of a link failed: ${reason}`)
    this.name = 'PinnedFetchFailed'
  }
}

const HTTPS_PROTOCOL = 'https:'
const HTTPS_PORT = 443
// The body is read as it is; a compressed one would be read past its limit once unpacked
const NO_ENCODING = 'identity'

// Failures that asking again does not change: the certificate of the host does not fit its name or
// does not chain to a root we trust, or the name does not exist. A refused or reset connection, a
// timeout and a DNS server that did not answer may pass.
const PERMANENT_CODES: ReadonlySet<string> = new Set([
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'ENOTFOUND',
  'ENODATA'
])

const codeOf = (error: unknown): string =>
  typeof (error as { code?: unknown } | null)?.code === 'string'
    ? (error as { code: string }).code
    : 'unknown'

export interface PinnedResponse {
  stream: Readable
  contentType: string
  contentLength: number | null
}

type Lookup = NonNullable<RequestOptions['lookup']>

// The address the check read, not a new answer of the resolver: whatever name the request is made to,
// the socket is opened to one of these. `all` is honored because the net module asks for it when it
// tries every family.
export function pinnedLookup(addresses: readonly string[]): Lookup {
  const entries = addresses.map(address => ({ address, family: isIP(address) === 6 ? 6 : 4 }))
  return ((_host: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) => {
    const first = entries[0]
    if (first === undefined) {
      callback(new Error('no address to connect to'))
      return
    }
    if (options.all === true) callback(null, entries)
    else callback(null, first.address, first.family)
  }) as unknown as Lookup
}

export type HttpsRequester = typeof httpsRequest

export interface PinnedGetOptions {
  accept: string
  timeoutMs: number
  resolve?: HostResolver
  // Replaceable so that a unit test needs no network
  request?: HttpsRequester
}

// GET of a link that came from outside, made by the core itself: plain https, a public address
// checked once and then the only one connected to (a host that changes its DNS answer after the
// check is not followed), and no redirect, because the address of a redirect is a new link nobody
// has checked. The body is not read here: the caller reads it with its own size limit.
export async function pinnedHttpsGet(
  raw: string,
  options: PinnedGetOptions
): Promise<PinnedResponse> {
  let target: PublicTarget
  try {
    target = await resolvePublicHttpsUrl(raw, options.resolve)
  } catch (error) {
    if (error instanceof UnsafeUrlError) throw error
    // The resolver itself failed: a name that does not exist is final, a server that did not answer is not
    const code = codeOf(error)
    throw new PinnedFetchFailed(`the host did not resolve (${code})`, !PERMANENT_CODES.has(code))
  }
  const { url, addresses } = target
  const send = options.request ?? httpsRequest
  const host = url.hostname.replace(/^\[|\]$/g, '')

  return new Promise<PinnedResponse>((resolve, reject) => {
    const req = send({
      protocol: HTTPS_PROTOCOL,
      hostname: host,
      port: HTTPS_PORT,
      path: `${url.pathname}${url.search}`,
      method: 'GET',
      headers: { accept: options.accept, 'accept-encoding': NO_ENCODING },
      // A socket of its own: a pooled one, opened for an earlier call, would not go through this lookup
      agent: new Agent({ keepAlive: false }),
      lookup: pinnedLookup(addresses),
      // The certificate is checked against the name of the link, not the address connected to
      ...(isIP(host) === 0 ? { servername: host } : {}),
      timeout: options.timeoutMs
    })
    req.on('timeout', () => {
      req.destroy(new PinnedFetchFailed('the server was too slow', true))
    })
    req.on('error', (error: Error) => {
      if (error instanceof PinnedFetchFailed) {
        reject(error)
        return
      }
      const code = codeOf(error)
      reject(new PinnedFetchFailed(`no answer (${code})`, !PERMANENT_CODES.has(code)))
    })
    req.on('response', response => {
      const status = response.statusCode ?? 0
      if (status < 200 || status >= 300) {
        response.resume()
        // 3xx is a redirect we do not follow; 429 and 5xx may pass
        reject(new PinnedFetchFailed(`status ${status}`, status === 429 || status >= 500))
        return
      }
      const length = Number(response.headers['content-length'])
      resolve({
        stream: response,
        contentType: String(response.headers['content-type'] ?? ''),
        contentLength: Number.isFinite(length) && length >= 0 ? length : null
      })
    })
    req.end()
  })
}
