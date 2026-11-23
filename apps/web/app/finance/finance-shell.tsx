'use client'

import { usePathname, useRouter } from 'next/navigation'
import { type ReactElement, type ReactNode, useEffect } from 'react'

import { type AccountMembership, AppPaths } from '@platform/api-client'
import { ClientPermissions } from '@platform/core/auth'

import { StoreProvider } from '../../components/providers/store-context'
import { SettingsFrame } from '../../components/settings/settings-frame'
import { PermissionDenied } from '../../components/settings/states'
import { AppFrame } from '../../components/shell/app-frame'
import { LoadingScreen, SessionGate } from '../../components/shell/session-gate'
import { bestFinanceMembership } from '../../lib/finance/area'
import {
  financeFamilyOfPath,
  financeMembershipOfFamily,
  visibleFinanceEntries
} from '../../lib/finance/family'
import { FINANCE_SETTINGS_ENTRIES, SettingsAreas } from '../../lib/settings/entries'
import { useProfile } from '../../lib/use-profile'

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
              <FinanceNavigation areaMembership={membership} memberships={profile.memberships}>
                {children}
              </FinanceNavigation>
            </AppFrame>
          </StoreProvider>
        )
      }}
    </SessionGate>
  )
}

// Each family of pages (the books, the purchases, the fiscal documents) is asked of the api through the store where the person holds ITS
// permissions: the api checks the permissions of the store of the request, so a person with `finance:*` in one store and `fiscal:*` in
// another would otherwise see the pages of one family answer 403, or miss the ones the api would allow.
function FinanceNavigation({
  areaMembership,
  memberships,
  children
}: {
  areaMembership: AccountMembership
  memberships: readonly AccountMembership[]
  children: ReactNode
}): ReactElement {
  const pathname = usePathname()
  const familyMembership = financeMembershipOfFamily(
    financeFamilyOfPath(pathname, FINANCE_SETTINGS_ENTRIES),
    memberships
  )
  const page = (
    <SettingsFrame
      area={SettingsAreas.FINANCE}
      entries={visibleFinanceEntries(FINANCE_SETTINGS_ENTRIES, memberships)}
    >
      {/* A name, a description or a reference typed by a person has no spaces to break at: it wraps anywhere in its box instead of pushing the page wide (a table keeps whole numbers and dates: it scrolls in its own box) */}
      <div className="min-w-0 wrap-anywhere [&_table]:wrap-normal">{children}</div>
    </SettingsFrame>
  )
  // No store opens this family: the page keeps the store of the area (the same provider, so the tree is not remounted) and its own
  // permission check says "no access" before it asks the api for anything
  return <StoreProvider membership={familyMembership ?? areaMembership}>{page}</StoreProvider>
}

// /finance has no content of its own: it opens the first page the person may see
export function FinanceHome(): ReactElement {
  const profile = useProfile()
  const router = useRouter()
  const href = !profile.isSuccess
    ? null
    : (visibleFinanceEntries(FINANCE_SETTINGS_ENTRIES, profile.data?.memberships ?? [])[0]?.href ??
      null)
  useEffect(() => {
    if (href !== null) router.replace(href)
  }, [href, router])
  if (!profile.isSuccess) return <LoadingScreen />
  return href === null ? <PermissionDenied permission={ClientPermissions.FINANCE_VIEW} /> : <></>
}

function NoAccess(): ReactElement {
  const router = useRouter()
  useEffect(() => {
    router.replace(AppPaths.noAccess)
  }, [router])
  return <LoadingScreen />
}
