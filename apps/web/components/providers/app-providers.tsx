'use client'

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useRouter } from 'next/navigation'
import { type ReactElement, type ReactNode, useEffect, useState } from 'react'

import { ApiError, AppPaths } from '@platform/api-client'

import { browserSession } from '../../lib/api'

const MAX_RETRIES = 2
const STALE_TIME_MS = 30_000

// Only a network failure (status 0) or a 5xx is worth a second try: a refusal, or an answer the
// page cannot read, will be the same again
function shouldRetry(failureCount: number, error: unknown): boolean {
  const transient = error instanceof ApiError && (error.status === 0 || error.status >= 500)
  return transient && failureCount < MAX_RETRIES
}

export function AppProviders({ children }: { children: ReactNode }): ReactElement {
  const router = useRouter()
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { retry: shouldRetry, staleTime: STALE_TIME_MS } }
      })
  )

  // The refresh found the session gone: nothing cached belongs to this person any more
  useEffect(
    () =>
      browserSession.onSessionLost(() => {
        queryClient.clear()
        router.replace(AppPaths.login)
      }),
    [queryClient, router]
  )

  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
}
