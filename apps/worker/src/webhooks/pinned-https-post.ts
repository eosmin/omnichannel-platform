import type { request as httpsRequest } from 'node:https'

import {
  type HostResolver,
  PERMANENT_NETWORK_CODES,
  PinnedExchangeFailed,
  PinnedExchangeReasons,
  pinnedHttpsExchange
} from '@platform/core/url-safety'

// The endpoint did not take the delivery. `status` is the answer when there was one, and `retryable` says whether sending the
// same delivery again may help: a refused connection, a slow answer, a 5xx, a 408 or a 429 may pass; any other 4xx, and a
// redirect (which is never followed), will not.
export class WebhookPostFailed extends Error {
  constructor(
    // One of WebhookDeliveryErrors (the reasons of the exchange are the same words), with the code of the network error after a colon when there is one
    readonly reason: string,
    readonly retryable: boolean,
    readonly status: number | null = null
  ) {
    super(`the webhook delivery failed: ${reason}`)
    this.name = 'WebhookPostFailed'
  }
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

// Whether sending the same delivery again may help, from what the exchange reported: the network error that follows the colon of
// a reason decides for a name or a connection that failed, a slow answer may pass, a status is judged by its number, and a
// request Node refused to build is refused again.
function retryableOf(failure: PinnedExchangeFailed): boolean {
  const [kind = '', code = ''] = failure.reason.split(':', 2)
  switch (kind) {
    case PinnedExchangeReasons.NOT_RESOLVED:
    case PinnedExchangeReasons.NO_ANSWER:
      return !PERMANENT_NETWORK_CODES.has(code)
    case PinnedExchangeReasons.TOO_SLOW:
      return true
    case PinnedExchangeReasons.BAD_STATUS: {
      const status = failure.status ?? 0
      return status === 408 || status === 429 || status >= 500
    }
    default:
      return false
  }
}

// POST of a delivery to an address the owner of a store typed: the pinned exchange of `@platform/core/url-safety` (plain https, a
// public address checked now and then the only one connected to, no redirect, one budget for the whole delivery) with the answer
// never read. Resolves with the status of a 2xx answer; whatever else is a WebhookPostFailed, or an UnsafeUrlError when the address
// no longer leads to the public internet.
export async function pinnedHttpsPost(raw: string, options: PinnedPostOptions): Promise<number> {
  try {
    const result = await pinnedHttpsExchange(raw, {
      body: options.body,
      headers: options.headers,
      timeoutMs: options.timeoutMs,
      discardBody: true,
      ...(options.resolve === undefined ? {} : { resolve: options.resolve }),
      ...(options.request === undefined ? {} : { request: options.request })
    })
    return result.status
  } catch (error) {
    if (error instanceof PinnedExchangeFailed) {
      throw new WebhookPostFailed(error.reason, retryableOf(error), error.status)
    }
    throw error
  }
}
