'use client'

import { useRouter } from 'next/navigation'
import { type ReactElement, useEffect } from 'react'

import { useStore } from '../../components/providers/store-context'
import { LoadingScreen } from '../../components/shell/session-gate'
import { storeRootTarget } from '../../lib/start-path'
import { useProfile } from '../../lib/use-profile'

// The address of the store itself (`/s/<id>`) is not a page: it goes to the first screen of the store that the person may open (the inbox
// for who has it), else one of another store of theirs. It is decided here, with the permissions of the person, because the server does not know them.
export function StoreRootRedirect(): ReactElement {
  const router = useRouter()
  const { storeId } = useStore()
  const profile = useProfile()
  const target =
    profile.data === undefined ? null : storeRootTarget(storeId, profile.data.memberships)
  useEffect(() => {
    if (target !== null) router.replace(target)
  }, [router, target])
  return <LoadingScreen />
}
