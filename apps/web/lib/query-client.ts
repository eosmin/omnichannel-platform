import { QueryClient } from '@tanstack/react-query'

import { ApiError } from '@platform/api-client'
import { RETRY_AFTER_METADATA_KEY } from '@platform/core/auth'
import { ClientErrorCodes } from '@platform/core/errors'

const MAX_RETRIES = 2
const STALE_TIME_MS = 30_000
// What the api is told is busy gets one more try, after the wait it asks for: three requests at once would
// put three of them to wait for the same lock
const BUSY_MAX_RETRIES = 1
const MAX_RETRY_DELAY_MS = 30_000

const isBusy = (error: unknown): boolean =>
  error instanceof ApiError && error.code === ClientErrorCodes.DATABASE_BUSY

// Only a network failure (status 0) or a 5xx is worth a second try: a refusal, or an answer the page cannot
// read, will be the same again. A DATABASE_BUSY (the api gave up on a lock after waiting up to 5 s) is tried
// once more, later (`retryDelay`), not twice at once.
export function shouldRetry(failureCount: number, error: unknown): boolean {
  const transient = error instanceof ApiError && (error.status === 0 || error.status >= 500)
  return transient && failureCount < (isBusy(error) ? BUSY_MAX_RETRIES : MAX_RETRIES)
}

// How long to wait before the next try: the wait the api asks for when it is busy, else the exponential
// default of the library (1 s, 2 s, 4 s, up to 30 s)
export function retryDelayOf(failureCount: number, error: unknown): number {
  if (error instanceof ApiError && isBusy(error)) {
    const seconds = error.metadata[RETRY_AFTER_METADATA_KEY]
    if (typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0) {
      return Math.min(Math.ceil(seconds) * 1000, MAX_RETRY_DELAY_MS)
    }
  }
  return Math.min(1000 * 2 ** failureCount, MAX_RETRY_DELAY_MS)
}

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: shouldRetry, retryDelay: retryDelayOf, staleTime: STALE_TIME_MS },
      // A save made with no network must fail now, in front of the person, so that the form shows it
      // and keeps what was typed. The default ('online') holds the mutation until the network is back:
      // the button says "Saving" for as long as it takes, and the save then runs on its own, behind a
      // dialog that may be closed by then.
      mutations: { networkMode: 'always' }
    }
  })
}
