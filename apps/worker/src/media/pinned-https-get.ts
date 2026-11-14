import { Agent, request as httpsRequest } from 'node:https'
import { isIP } from 'node:net'
import type { Readable } from 'node:stream'

import {
  errorCodeOf,
  type HostResolver,
  PERMANENT_NETWORK_CODES,
  pinnedLookup,
  type PublicTarget,
  resolvePublicHttpsUrl,
  UnsafeUrlError
} from '@platform/core/url-safety'

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
