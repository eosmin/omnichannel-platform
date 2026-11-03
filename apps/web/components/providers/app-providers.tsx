'use client'

import { QueryClientProvider } from '@tanstack/react-query'
import { useRouter } from 'next/navigation'
import { type ReactElement, type ReactNode, useEffect, useState } from 'react'

import { AppPaths } from '@platform/api-client'

import { browserSession } from '../../lib/api'
import { createQueryClient } from '../../lib/query-client'

export function AppProviders({ children }: { children: ReactNode }): ReactElement {
  const router = useRouter()
  const [queryClient] = useState(createQueryClient)

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
