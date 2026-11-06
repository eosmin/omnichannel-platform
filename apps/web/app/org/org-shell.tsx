'use client'

import { useRouter } from 'next/navigation'
import { type ReactElement, type ReactNode, useEffect } from 'react'

import { AppPaths } from '@platform/api-client'
import { ClientPermissions } from '@platform/core/auth'

import { StoreProvider, useStore } from '../../components/providers/store-context'
import { SettingsFrame } from '../../components/settings/settings-frame'
import { AppFrame } from '../../components/shell/app-frame'
import { LoadingScreen, SessionGate } from '../../components/shell/session-gate'
import {
  firstVisibleHref,
  ORG_SETTINGS_ENTRIES,
  SettingsAreas,
  visibleEntries
} from '../../lib/settings/entries'

// The organization pages are asked of the api through one of the person's stores (it reads the
// organization from X-Store-Id), so the area needs a store where they may open them. A store where
// they manage stores comes first, because it opens every page; one where they may only look at
// settings still opens the organization profile. Nobody else has anything to do here.
export function OrgShell({ children }: { children: ReactNode }): ReactElement {
  return (
    <SessionGate>
      {profile => {
        const membership =
          profile.memberships.find(item =>
            item.permissions.includes(ClientPermissions.ORG_MANAGE_STORES)
          ) ??
          profile.memberships.find(item =>
            item.permissions.includes(ClientPermissions.SETTINGS_VIEW)
          )
        return membership === undefined ? (
          <NoAccess />
        ) : (
          <StoreProvider membership={membership}>
            <AppFrame profile={profile} currentStoreId={null}>
              <OrgNavigation>{children}</OrgNavigation>
            </AppFrame>
          </StoreProvider>
        )
      }}
    </SessionGate>
  )
}

function OrgNavigation({ children }: { children: ReactNode }): ReactElement {
  const { can } = useStore()
  return (
    <SettingsFrame area={SettingsAreas.ORG} entries={visibleEntries(ORG_SETTINGS_ENTRIES, can)}>
      {children}
    </SettingsFrame>
  )
}

// /org has no content of its own: it opens the first page the person may see
export function OrgHome(): ReactElement {
  const { can } = useStore()
  const router = useRouter()
  const href = firstVisibleHref(ORG_SETTINGS_ENTRIES, can)
  useEffect(() => {
    if (href !== null) router.replace(href)
  }, [href, router])
  return <></>
}

function NoAccess(): ReactElement {
  const router = useRouter()
  useEffect(() => {
    router.replace(AppPaths.noAccess)
  }, [router])
  return <LoadingScreen />
}
