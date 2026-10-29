'use client'

import { useRouter } from 'next/navigation'
import { type ReactElement, type ReactNode, useEffect } from 'react'

import { AppPaths } from '@platform/api-client'

import { StoreProvider } from '../../components/providers/store-context'
import { AppFrame } from '../../components/shell/app-frame'
import { LoadingScreen, SessionGate } from '../../components/shell/session-gate'
import { rememberLastStoreId } from '../../lib/last-store'

// Everything under /s/[storeId]. The profile says which stores the person belongs to; one that is
// not in the list (a removed member, a link from someone else) goes to the no-access screen. The api
// refuses the requests anyway: this only spares the person a page full of errors.
export function StoreShell({
  storeId,
  children
}: {
  storeId: string
  children: ReactNode
}): ReactElement {
  return (
    <SessionGate>
      {profile => {
        const membership = profile.memberships.find(item => item.storeId === storeId)
        return membership === undefined ? (
          <NoMembership />
        ) : (
          <StoreProvider membership={membership}>
            <Remember storeId={storeId} />
            <AppFrame profile={profile} currentStoreId={storeId}>
              {children}
            </AppFrame>
          </StoreProvider>
        )
      }}
    </SessionGate>
  )
}

function NoMembership(): ReactElement {
  const router = useRouter()
  useEffect(() => {
    router.replace(AppPaths.noAccess)
  }, [router])
  return <LoadingScreen />
}

// "/" goes to the store used last
function Remember({ storeId }: { storeId: string }): null {
  useEffect(() => {
    rememberLastStoreId(storeId)
  }, [storeId])
  return null
}
