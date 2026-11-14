import { Agent, request as httpsRequest } from 'node:https'
import { isIP } from 'node:net'

import { WebhookDeliveryErrors } from '@platform/core/domain'
import {
  errorCodeOf,
  type HostResolver,
  PERMANENT_NETWORK_CODES,
  pinnedLookup,
  type PublicTarget,
  resolvePublicHttpsUrl,
  UnsafeUrlError
} from '@platform/core/url-safety'

// The endpoint did not take the delivery. `status` is the answer when there was one, and `retryable` says whether sending the
// same delivery again may help: a refused connection, a slow answer, a 5xx, a 408 or a 429 may pass; any other 4xx, and a
// redirect (which is never followed), will not.
export class WebhookPostFailed extends Error {
  constructor(
    // One of WebhookDeliveryErrors, with the code of the network error after a colon when there is one
    readonly reason: string,
    readonly retryable: boolean,
    readonly status: number | null = null
  ) {
    super(`the webhook delivery failed: ${reason}`)
    this.name = 'WebhookPostFailed'
  }
}

const HTTPS_PORT = 443

// The promise as it settles, or a failure that may pass when it takes longer than `ms`
function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new WebhookPostFailed(WebhookDeliveryErrors.TOO_SLOW, true))
    }, ms)
  })
  return Promise.race([work, late]).finally(() => {
    clearTimeout(timer)
  })
}

export type HttpsRequester = typeof httpsRequest

export interface PinnedPostOptions {
  body: string
  headers: Readonly<Record<string, string>>
  timeoutMs: number
  resolve?: HostResolver
  // Replaceable so that a unit test needs no network
  request?: HttpsRequester
}

// POST of a delivery to an address the owner of a store typed: plain https, a public address checked now and then the only
// one connected to (a host that changes its DNS answer after the check is not followed), and no redirect, because the address
// of a redirect is a new one nobody has checked. Resolves with the status of a 2xx answer; whatever else is a WebhookPostFailed,
// or an UnsafeUrlError when the address no longer leads to the public internet. The body of the answer is never read.
export async function pinnedHttpsPost(raw: string, options: PinnedPostOptions): Promise<number> {
  // One budget for the whole delivery: what the resolver spends is not given again to the request
  const startedAt = Date.now()
  let target: PublicTarget
  try {
    // The resolver has no deadline of its own: a slow name server must not hold the job longer than the delivery may take
    target = await withDeadline(resolvePublicHttpsUrl(raw, options.resolve), options.timeoutMs)
  } catch (error) {
    if (error instanceof UnsafeUrlError || error instanceof WebhookPostFailed) throw error
    const code = errorCodeOf(error)
    throw new WebhookPostFailed(
      `${WebhookDeliveryErrors.NOT_RESOLVED}:${code}`,
      !PERMANENT_NETWORK_CODES.has(code)
    )
  }
  const { url, addresses } = target
  const remainingMs = Math.max(1, options.timeoutMs - (Date.now() - startedAt))
  const send = options.request ?? httpsRequest
  const host = url.hostname.replace(/^\[|\]$/g, '')
  const payload = Buffer.from(options.body, 'utf8')

  return new Promise<number>((resolve, reject) => {
    let settled = false
    const timers: { deadline?: NodeJS.Timeout } = {}
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
      // A header value Node refuses (a line break in it): the same job will be refused again
      reject(new WebhookPostFailed(WebhookDeliveryErrors.REQUEST_REFUSED, false))
      return
    }
    // The socket timeout restarts with every byte, so an endpoint that drips its answer would never trip it: this one bounds the
    // whole exchange
    timers.deadline = setTimeout(() => {
      req.destroy(new WebhookPostFailed(WebhookDeliveryErrors.TOO_SLOW, true))
    }, remainingMs)
    req.on('timeout', () => {
      req.destroy(new WebhookPostFailed(WebhookDeliveryErrors.TOO_SLOW, true))
    })
    req.on('error', (error: Error) => {
      finish(() => {
        if (error instanceof WebhookPostFailed) {
          reject(error)
          return
        }
        const code = errorCodeOf(error)
        reject(
          new WebhookPostFailed(
            `${WebhookDeliveryErrors.NO_ANSWER}:${code}`,
            !PERMANENT_NETWORK_CODES.has(code)
          )
        )
      })
    })
    req.on('response', response => {
      const status = response.statusCode ?? 0
      // The answer is not read, and the socket is not kept: nothing the endpoint sends after its status is waited for
      response.resume()
      finish(() => {
        if (status >= 200 && status < 300) {
          resolve(status)
          return
        }
        reject(
          new WebhookPostFailed(
            WebhookDeliveryErrors.BAD_STATUS,
            status === 408 || status === 429 || status >= 500,
            status
          )
        )
      })
      req.destroy()
    })
    req.end(payload)
  })
}
