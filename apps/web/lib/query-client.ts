import { QueryClient } from '@tanstack/react-query'

import { ApiError } from '@platform/api-client'

const MAX_RETRIES = 2
const STALE_TIME_MS = 30_000

// Only a network failure (status 0) or a 5xx is worth a second try: a refusal, or an answer the
// page cannot read, will be the same again
export function shouldRetry(failureCount: number, error: unknown): boolean {
  const transient = error instanceof ApiError && (error.status === 0 || error.status >= 500)
  return transient && failureCount < MAX_RETRIES
}

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: shouldRetry, staleTime: STALE_TIME_MS },
      // A save made with no network must fail now, in front of the person, so that the form shows it
      // and keeps what was typed. The default ('online') holds the mutation until the network is back:
      // the button says "Saving" for as long as it takes, and the save then runs on its own, behind a
      // dialog that may be closed by then.
      mutations: { networkMode: 'always' }
    }
  })
}
