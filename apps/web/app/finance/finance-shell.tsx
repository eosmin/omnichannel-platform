'use client'

import { useRouter } from 'next/navigation'
import { type ReactElement, type ReactNode, useEffect } from 'react'

import { AppPaths } from '@platform/api-client'
import { ClientPermissions } from '@platform/core/auth'

import { StoreProvider, useStore } from '../../components/providers/store-context'
import { SettingsFrame } from '../../components/settings/settings-frame'
import { PermissionDenied } from '../../components/settings/states'
import { AppFrame } from '../../components/shell/app-frame'
import { LoadingScreen, SessionGate } from '../../components/shell/session-gate'
import { bestFinanceMembership } from '../../lib/finance/area'
import {
  FINANCE_SETTINGS_ENTRIES,
  firstVisibleHref,
  SettingsAreas,
  visibleEntries
} from '../../lib/settings/entries'

// The books are the organization's and are asked of the api through one of the person's stores (it reads the organization from
// X-Store-Id), so the area needs a store where the person holds a finance permission. Nobody else has anything to do here.
export function FinanceShell({ children }: { children: ReactNode }): ReactElement {
  return (
    <SessionGate>
      {profile => {
        const membership = bestFinanceMembership(profile.memberships)
        return membership === undefined ? (
          <NoAccess />
        ) : (
          <StoreProvider membership={membership}>
            <AppFrame profile={profile} currentStoreId={null}>
              <FinanceNavigation>{children}</FinanceNavigation>
            </AppFrame>
          </StoreProvider>
        )
      }}
    </SessionGate>
  )
}

function FinanceNavigation({ children }: { children: ReactNode }): ReactElement {
  const { can } = useStore()
  return (
    <SettingsFrame
      area={SettingsAreas.FINANCE}
      entries={visibleEntries(FINANCE_SETTINGS_ENTRIES, can)}
    >
      {/* A name, a description or a reference typed by a person has no spaces to break at: it wraps anywhere in its box instead of pushing the page wide (a table keeps whole numbers and dates: it scrolls in its own box) */}
      <div className="min-w-0 wrap-anywhere [&_table]:wrap-normal">{children}</div>
    </SettingsFrame>
  )
}

// /finance has no content of its own: it opens the first page the person may see
export function FinanceHome(): ReactElement {
  const { can } = useStore()
  const router = useRouter()
  const href = firstVisibleHref(FINANCE_SETTINGS_ENTRIES, can)
  useEffect(() => {
    if (href !== null) router.replace(href)
  }, [href, router])
  return href === null ? <PermissionDenied permission={ClientPermissions.FINANCE_VIEW} /> : <></>
}

function NoAccess(): ReactElement {
  const router = useRouter()
  useEffect(() => {
    router.replace(AppPaths.noAccess)
  }, [router])
  return <LoadingScreen />
}
