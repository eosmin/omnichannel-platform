'use client'

import { useRouter } from 'next/navigation'
import { type ReactElement, useEffect } from 'react'

import { AppPaths } from '@platform/api-client'

import { useStore } from '../../components/providers/store-context'
import { LoadingScreen } from '../../components/shell/session-gate'
import { storeLandingPath } from '../../lib/store-landing'

// The address of the store itself (`/s/<id>`) is not a page: it goes to the first screen of the store that the person may open (the inbox
// for who has it). It is decided here, with the permissions of the person, because the server does not know them.
export function StoreRootRedirect(): ReactElement {
  const router = useRouter()
  const { storeId, can } = useStore()
  const target = storeLandingPath(storeId, can) ?? AppPaths.noAccess
  useEffect(() => {
    router.replace(target)
  }, [router, target])
  return <LoadingScreen />
}
