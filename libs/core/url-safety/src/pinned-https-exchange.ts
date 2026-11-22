import { errorCodeOf } from './pinned-errors'
import { type HttpsRequester, openPinnedRequest } from './pinned-request'
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

// What the exchange does with the answer: it is read up to a ceiling that the caller must state (an address that streams must not
// fill memory), or it is never read: a 2xx then resolves with an empty body as soon as its status is known, and the socket is
// dropped (for a caller that only needs to know the other side took the request, a webhook delivery).
export type PinnedAnswerReading =
  | { maxResponseBytes: number; discardBody?: false }
  | { discardBody: true; maxResponseBytes?: undefined }

export type PinnedExchangeOptions = PinnedAnswerReading & {
  body: string
  headers: Readonly<Record<string, string>>
  timeoutMs: number
  // The answer of any status is read (up to the same ceiling) and returned, for a caller that decides by the status and the body
  // of a refusal (TDD_10 §6.7.4). Without it only a 2xx resolves and any other status is a `bad_status` failure.
  anyStatus?: boolean
  resolve?: HostResolver
  // Replaceable so that a unit test needs no network
  request?: HttpsRequester
}

export interface PinnedExchangeResult {
  status: number
  body: string
}

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
  const remainingMs = Math.max(1, options.timeoutMs - (Date.now() - startedAt))
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
      req = openPinnedRequest(target, {
        method: 'POST',
        headers: { ...options.headers, 'content-length': String(payload.length) },
        timeoutMs: remainingMs,
        request: options.request
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
      if (options.anyStatus !== true && (status < 200 || status >= 300)) {
        response.resume()
        finish(() => {
          reject(new PinnedExchangeFailed(PinnedExchangeReasons.BAD_STATUS, status))
        })
        req.destroy()
        return
      }
      if (options.discardBody) {
        // The answer is not read, and the socket is not kept: nothing the other side sends after its status is waited for
        response.resume()
        finish(() => {
          resolve({ status, body: '' })
        })
        req.destroy()
        return
      }
      const maxBytes = options.maxResponseBytes
      const chunks: Buffer[] = []
      let size = 0
      response.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > maxBytes) {
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
