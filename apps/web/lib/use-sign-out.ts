'use client'

import { useQueryClient } from '@tanstack/react-query'
import { useRouter } from 'next/navigation'
import { useState } from 'react'

import { AppPaths } from '@platform/api-client'

import { apiClient, browserSession } from './api'
import { resetDraftIndex } from './inbox/composer-draft-index'
import { clearComposerDrafts } from './inbox/composer-drafts'
import { readLastStoreId } from './last-store'
import { unsubscribeFromPush } from './push/push-browser'
import { toast } from './toast'
import { useErrorText } from './use-error-text'

// How long leaving waits for the browser to drop its push registration: leaving must not depend on it
const PUSH_REMOVAL_WAIT_MS = 3000

// Ends the session on the server (which clears the cookie even if the api fails) and leaves. If the
// server cannot be reached the cookie may still be there, and leaving would bounce straight back in:
// it says so and stays.
export function useSignOut(redirectTo: string = AppPaths.login): {
  signOut: () => Promise<void>
  pending: boolean
} {
  const errorText = useErrorText()
  const router = useRouter()
  const queryClient = useQueryClient()
  const [pending, setPending] = useState(false)

  async function signOut(): Promise<void> {
    setPending(true)
    // Before the session ends, because the api asks who is removing the browser
    await Promise.race([
      unsubscribeFromPush(apiClient, readLastStoreId()),
      new Promise<void>(resolve => setTimeout(resolve, PUSH_REMOVAL_WAIT_MS))
    ])
    try {
      await browserSession.logout()
    } catch (error) {
      toast.error(errorText(error))
      setPending(false)
      return
    }
    // What the person was writing does not stay in the browser for the next one
    clearComposerDrafts(window.sessionStorage)
    resetDraftIndex()
    queryClient.clear()
    router.replace(redirectTo)
  }

  return { signOut, pending }
}
