import { Agent, request as httpsRequest } from 'node:https'
import { isIP } from 'node:net'
import type { Readable } from 'node:stream'

import { errorCodeOf, PERMANENT_NETWORK_CODES } from './pinned-errors'
import type { HttpsRequester } from './pinned-https-exchange'
import { pinnedLookup } from './pinned-lookup'
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

export interface PinnedResponse {
  stream: Readable
  contentType: string
  contentLength: number | null
}

// What a caller cannot set: the host a shared front end would route by, and the framing of the message
export const FORBIDDEN_HEADERS: ReadonlySet<string> = new Set([
  'host',
  'content-length',
  'transfer-encoding',
  'connection',
  'upgrade',
  'te',
  'trailer',
  'accept',
  'accept-encoding'
])

export interface PinnedGetOptions {
  accept: string
  timeoutMs: number
  // Extra headers of the request. Never the ones that say where the request goes or how its body is framed (`FORBIDDEN_HEADERS`: the
  // function connects to the address it checked and to no other, and reads the body as it is), and `accept` and `accept-encoding`
  // are the caller's `accept` and the identity the body is read with
  headers?: Readonly<Record<string, string>>
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
  for (const name of Object.keys(options.headers ?? {})) {
    if (FORBIDDEN_HEADERS.has(name.toLowerCase())) {
      throw new TypeError(`the header ${name} cannot be set on a pinned request`)
    }
  }
  let target: PublicTarget
  try {
    target = await resolvePublicHttpsUrl(raw, options.resolve)
  } catch (error) {
    if (error instanceof UnsafeUrlError) throw error
    // The resolver itself failed: a name that does not exist is final, a server that did not answer is not
    const code = errorCodeOf(error)
    throw new PinnedFetchFailed(
      `the host did not resolve (${code})`,
      !PERMANENT_NETWORK_CODES.has(code)
    )
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
      headers: { ...options.headers, accept: options.accept, 'accept-encoding': NO_ENCODING },
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
      const code = errorCodeOf(error)
      reject(new PinnedFetchFailed(`no answer (${code})`, !PERMANENT_NETWORK_CODES.has(code)))
    })
    req.on('response', response => {
      const status = response.statusCode ?? 0
      if (status < 200 || status >= 300) {
        response.resume()
        // 3xx is a redirect we do not follow; 429 and 5xx may pass
        reject(new PinnedFetchFailed(`status ${status}`, status === 429 || status >= 500))
        return
      }
      // The body is read as it is (`identity`): a server that compresses anyway would let a small download unpack past the
      // limit of whoever reads it
      const encoding = String(response.headers['content-encoding'] ?? 'identity')
        .trim()
        .toLowerCase()
      if (encoding !== '' && encoding !== NO_ENCODING) {
        response.resume()
        reject(new PinnedFetchFailed('the body is encoded', false))
        return
      }
      const declared = String(response.headers['content-length'] ?? '').trim()
      const length = declared === '' ? Number.NaN : Number(declared)
      resolve({
        stream: response,
        contentType: String(response.headers['content-type'] ?? ''),
        contentLength: Number.isFinite(length) && length >= 0 ? length : null
      })
    })
    req.end()
  })
}
