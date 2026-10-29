'use client'

import { useQueryClient } from '@tanstack/react-query'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { useState } from 'react'
import { toast } from 'sonner'

import { AppPaths } from '@platform/api-client'

import { browserSession } from './api'
import { errorCodeOf } from './error-message'

// Ends the session on the server (which clears the cookie even if the api fails) and leaves. If the
// server cannot be reached the cookie may still be there, and leaving would bounce straight back in:
// it says so and stays.
export function useSignOut(redirectTo: string = AppPaths.login): {
  signOut: () => Promise<void>
  pending: boolean
} {
  const t = useTranslations()
  const router = useRouter()
  const queryClient = useQueryClient()
  const [pending, setPending] = useState(false)

  async function signOut(): Promise<void> {
    setPending(true)
    try {
      await browserSession.logout()
    } catch (error) {
      toast.error(t(`errors.${errorCodeOf(error)}`))
      setPending(false)
      return
    }
    queryClient.clear()
    router.replace(redirectTo)
  }

  return { signOut, pending }
}
