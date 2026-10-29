'use client'

import { useRouter } from 'next/navigation'
import { type ReactElement, type ReactNode, useEffect } from 'react'

import { AppPaths } from '@platform/api-client'
import { Permissions } from '@platform/core/auth'

import { StoreProvider } from '../../components/providers/store-context'
import { AppFrame } from '../../components/shell/app-frame'
import { LoadingScreen, SessionGate } from '../../components/shell/session-gate'

// The organization pages are asked of the api through one of the person's stores (it reads the
// organization from X-Store-Id), so the area needs a store where they may manage stores. Nobody
// else has anything to do here.
export function OrgShell({ children }: { children: ReactNode }): ReactElement {
  return (
    <SessionGate>
      {profile => {
        const membership = profile.memberships.find(item =>
          item.permissions.includes(Permissions.ORG_MANAGE_STORES)
        )
        return membership === undefined ? (
          <NoAccess />
        ) : (
          <StoreProvider membership={membership}>
            <AppFrame profile={profile} currentStoreId={null}>
              {children}
            </AppFrame>
          </StoreProvider>
        )
      }}
    </SessionGate>
  )
}

function NoAccess(): ReactElement {
  const router = useRouter()
  useEffect(() => {
    router.replace(AppPaths.noAccess)
  }, [router])
  return <LoadingScreen />
}
