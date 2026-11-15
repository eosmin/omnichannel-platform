import { Agent, request as httpsRequest } from 'node:https'
import { isIP } from 'node:net'

import { errorCodeOf } from './pinned-errors'
import { pinnedLookup } from './pinned-lookup'
import {
  type HostResolver,
  type PublicTarget,
  resolvePublicHttpsUrl,
  UnsafeUrlError
} from './public-url'

export const PinnedExchangeReasons = {
  NOT_RESOLVED: 'not_resolved',
  NO_ANSWER: 'no_answer',
  TOO_SLOW: 'too_slow',
  BAD_STATUS: 'bad_status',
  TOO_LARGE: 'too_large',
  REQUEST_REFUSED: 'request_refused'
} as const

// The exchange did not complete. `reason` is one of PinnedExchangeReasons and never carries what the other side sent.
export class PinnedExchangeFailed extends Error {
  constructor(
    readonly reason: string,
    readonly status: number | null = null
  ) {
    super(`the exchange failed: ${reason}`)
    this.name = 'PinnedExchangeFailed'
  }
}

export type HttpsRequester = typeof httpsRequest

export interface PinnedExchangeOptions {
  body: string
  headers: Readonly<Record<string, string>>
  timeoutMs: number
  // The answer is read up to this many bytes; a longer one fails (an address that streams must not fill memory)
  maxResponseBytes: number
  resolve?: HostResolver
  // Replaceable so that a unit test needs no network
  request?: HttpsRequester
}

export interface PinnedExchangeResult {
  status: number
  body: string
}

const HTTPS_PORT = 443

function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new PinnedExchangeFailed(PinnedExchangeReasons.TOO_SLOW))
    }, ms)
  })
  return Promise.race([work, late]).finally(() => {
    clearTimeout(timer)
  })
}

// A POST to an address a person typed, whose answer is read: plain https, a public address checked now and then the only
// one connected to (a host that changes its DNS answer after the check is not followed), no redirect (the address of a redirect
// is a new one nobody has checked), one budget for the whole exchange, and an answer read up to a ceiling. Resolves with a 2xx
// answer; whatever else is a PinnedExchangeFailed, or an UnsafeUrlError when the address does not lead to the public internet.
export async function pinnedHttpsExchange(
  raw: string,
  options: PinnedExchangeOptions
): Promise<PinnedExchangeResult> {
  const startedAt = Date.now()
  let target: PublicTarget
  try {
    target = await withDeadline(resolvePublicHttpsUrl(raw, options.resolve), options.timeoutMs)
  } catch (error) {
    if (error instanceof UnsafeUrlError || error instanceof PinnedExchangeFailed) throw error
    throw new PinnedExchangeFailed(`${PinnedExchangeReasons.NOT_RESOLVED}:${errorCodeOf(error)}`)
  }
  const { url, addresses } = target
  const remainingMs = Math.max(1, options.timeoutMs - (Date.now() - startedAt))
  const send = options.request ?? httpsRequest
  const host = url.hostname.replace(/^\[|\]$/g, '')
  const payload = Buffer.from(options.body, 'utf8')

  return new Promise<PinnedExchangeResult>((resolve, reject) => {
    let settled = false
    const timers: { deadline?: NodeJS.Timeout } = {}
    let timedOut = false
    const finish = (settle: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timers.deadline)
      settle()
    }
    let req: ReturnType<HttpsRequester>
    try {
      req = send({
        protocol: 'https:',
        hostname: host,
        port: HTTPS_PORT,
        path: `${url.pathname}${url.search}`,
        method: 'POST',
        headers: { ...options.headers, 'content-length': String(payload.length) },
        // A socket of its own: a pooled one, opened for an earlier call, would not go through this lookup
        agent: new Agent({ keepAlive: false }),
        lookup: pinnedLookup(addresses),
        // The certificate is checked against the name of the address, not the address connected to
        ...(isIP(host) === 0 ? { servername: host } : {}),
        timeout: remainingMs
      })
    } catch {
      reject(new PinnedExchangeFailed(PinnedExchangeReasons.REQUEST_REFUSED))
      return
    }
    // The socket timeout restarts with every byte: this one bounds the whole exchange
    timers.deadline = setTimeout(() => {
      timedOut = true
      req.destroy(new PinnedExchangeFailed(PinnedExchangeReasons.TOO_SLOW))
    }, remainingMs)
    req.on('timeout', () => {
      req.destroy(new PinnedExchangeFailed(PinnedExchangeReasons.TOO_SLOW))
    })
    req.on('error', (error: Error) => {
      finish(() => {
        reject(
          error instanceof PinnedExchangeFailed
            ? error
            : new PinnedExchangeFailed(`${PinnedExchangeReasons.NO_ANSWER}:${errorCodeOf(error)}`)
        )
      })
    })
    req.on('response', response => {
      const status = response.statusCode ?? 0
      if (status < 200 || status >= 300) {
        response.resume()
        finish(() => {
          reject(new PinnedExchangeFailed(PinnedExchangeReasons.BAD_STATUS, status))
        })
        req.destroy()
        return
      }
      const chunks: Buffer[] = []
      let size = 0
      response.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > options.maxResponseBytes) {
          finish(() => {
            reject(new PinnedExchangeFailed(PinnedExchangeReasons.TOO_LARGE, status))
          })
          req.destroy()
          return
        }
        chunks.push(chunk)
      })
      response.on('end', () => {
        finish(() => {
          resolve({ status, body: Buffer.concat(chunks).toString('utf8') })
        })
      })
      response.on('error', () => {
        finish(() => {
          // The deadline destroys the request, and the answer that was streaming reports it as an abort
          reject(
            new PinnedExchangeFailed(
              timedOut ? PinnedExchangeReasons.TOO_SLOW : PinnedExchangeReasons.NO_ANSWER,
              status
            )
          )
        })
      })
    })
    req.end(payload)
  })
}
