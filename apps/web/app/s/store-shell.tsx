'use client'

import dynamic from 'next/dynamic'
import { useRouter } from 'next/navigation'
import { type ReactElement, type ReactNode, useEffect } from 'react'

import { AppPaths } from '@platform/api-client'

import { CustomerDrawerProvider } from '../../components/customers/customer-drawer-context'
import { OrderDrawerProvider } from '../../components/orders/order-drawer-context'
import { RealtimeProvider } from '../../components/providers/realtime-provider'
import { StoreProvider } from '../../components/providers/store-context'
import { StoreTimeZone } from '../../components/providers/time-zone-provider'
import { AppFrame } from '../../components/shell/app-frame'
import { LoadingScreen, SessionGate } from '../../components/shell/session-gate'
import { StoreNav } from '../../components/shell/store-nav'
import { rememberLastStoreId } from '../../lib/last-store'
import { usePushSync } from '../../lib/push/use-push-offer'

// Only a suspended person ever loads this, so it stays out of the chunk every store page shares
const Suspended = dynamic(() => import('./suspended-store').then(module => module.SuspendedStore), {
  ssr: false
})

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
            <StoreTimeZone />
            <PushSync storeId={storeId} />
            <RealtimeProvider storeId={storeId} userId={profile.id}>
              <CustomerDrawerProvider>
                <OrderDrawerProvider>
                  <AppFrame profile={profile} currentStoreId={storeId} nav={<StoreNav />}>
                    {children}
                  </AppFrame>
                </OrderDrawerProvider>
              </CustomerDrawerProvider>
            </RealtimeProvider>
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

// Registers this browser again for push when it allows it (see `usePushSync`). Renders nothing.
function PushSync({ storeId }: { storeId: string }): null {
  usePushSync(storeId)
  return null
}

// "/" goes to the store used last
function Remember({ storeId }: { storeId: string }): null {
  useEffect(() => {
    rememberLastStoreId(storeId)
  }, [storeId])
  return null
}
