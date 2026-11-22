import type { Readable } from 'node:stream'

import { errorCodeOf, PERMANENT_NETWORK_CODES } from './pinned-errors'
import { type HttpsRequester, openPinnedRequest } from './pinned-request'
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

// The body is read as it is; a compressed one would be read past its limit once unpacked
const NO_ENCODING = 'identity'

export interface PinnedResponse {
  stream: Readable
  contentType: string
  contentLength: number | null
}

// What a caller may add to the request: its own `x-` headers (a signature, an id). Nothing that says where the request goes, how its
// body is framed or who is asking (`host`, `content-length`, `connection`, `proxy-authorization`, `expect`, `cookie`...), and a name
// is judged lower-cased, so two spellings of one cannot both pass
const ALLOWED_HEADER = /^x-[a-z0-9-]+$/

export interface PinnedGetOptions {
  accept: string
  timeoutMs: number
  // Extra headers of the request: only `x-` ones (`ALLOWED_HEADER`). The function connects to the address it checked and to no other,
  // and reads the body as it is, so nothing that routes or frames the request can be set from outside
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
  const extra = new Set<string>()
  for (const name of Object.keys(options.headers ?? {})) {
    const lower = name.toLowerCase()
    if (!ALLOWED_HEADER.test(lower) || extra.has(lower)) {
      throw new TypeError(`the header ${name} cannot be set on a pinned request`)
    }
    extra.add(lower)
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
  return new Promise<PinnedResponse>((resolve, reject) => {
    const req = openPinnedRequest(target, {
      method: 'GET',
      headers: { ...options.headers, accept: options.accept, 'accept-encoding': NO_ENCODING },
      timeoutMs: options.timeoutMs,
      request: options.request
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
