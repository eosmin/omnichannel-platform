'use client'

import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { type ReactElement, type ReactNode, useEffect } from 'react'
import { toast } from 'sonner'

import { type AccountProfile, AppPaths } from '@platform/api-client'

import { CustomerDrawerProvider } from '../../components/customers/customer-drawer-context'
import { RealtimeProvider } from '../../components/providers/realtime-provider'
import { StoreProvider } from '../../components/providers/store-context'
import { AppFrame } from '../../components/shell/app-frame'
import { LoadingScreen, SessionGate } from '../../components/shell/session-gate'
import { StoreNav } from '../../components/shell/store-nav'
import { rememberLastStoreId } from '../../lib/last-store'
import { chooseStartPath } from '../../lib/start-path'

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
        if (membership === undefined) {
          const suspended = profile.suspendedStores.find(item => item.storeId === storeId)
          return suspended === undefined ? (
            <NoMembership />
          ) : (
            <Suspended storeId={storeId} storeName={suspended.storeName} profile={profile} />
          )
        }
        return (
          <StoreProvider membership={membership}>
            <Remember storeId={storeId} />
            <RealtimeProvider storeId={storeId} userId={profile.id}>
              <CustomerDrawerProvider>
                <AppFrame profile={profile} currentStoreId={storeId} nav={<StoreNav />}>
                  {children}
                </AppFrame>
              </CustomerDrawerProvider>
            </RealtimeProvider>
          </StoreProvider>
        )
      }}
    </SessionGate>
  )
}

// A store the person was suspended in (opened by its link, or the one used last): they are told, and
// sent to a store they can still enter, or to the screen that explains the suspension when they have
// none. "/" never targets a store they are suspended in, so this cannot loop.
function Suspended({
  storeId,
  storeName,
  profile
}: {
  storeId: string
  storeName: string
  profile: AccountProfile
}): ReactElement {
  const t = useTranslations('noAccess')
  const router = useRouter()
  const target = chooseStartPath(profile.memberships, null)
  useEffect(() => {
    // With no store left the screen it goes to says it all; the toast is for the person who moves on
    if (profile.memberships.length > 0) {
      toast.error(t('suspendedNotice', { store: storeName }), { id: `suspended-${storeId}` })
    }
    router.replace(target)
  }, [router, t, storeId, storeName, target, profile.memberships.length])
  return <LoadingScreen />
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
