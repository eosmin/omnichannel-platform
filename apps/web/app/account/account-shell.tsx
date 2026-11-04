'use client'

import { useTranslations } from 'next-intl'
import type { ReactElement, ReactNode } from 'react'

import { RealtimeProvider } from '../../components/providers/realtime-provider'
import { SettingsFrame } from '../../components/settings/settings-frame'
import { AppFrame } from '../../components/shell/app-frame'
import { SessionGate } from '../../components/shell/session-gate'
import { accountInboxPath, accountRealtimeStoreId } from '../../lib/account-realtime-store'
import { readLastStoreId } from '../../lib/last-store'
import { ACCOUNT_SETTINGS_ENTRIES, SettingsAreas } from '../../lib/settings/entries'

export function AccountShell({ children }: { children: ReactNode }): ReactElement {
  const t = useTranslations('settings.nav')
  return (
    <SessionGate>
      {profile => {
        // The bell and the socket follow the same store: the last one the person still belongs to
        const lastStoreId = readLastStoreId()
        const realtimeStoreId = accountRealtimeStoreId(profile, lastStoreId)
        const inboxPath = accountInboxPath(profile, lastStoreId)
        const frame = (
          <AppFrame profile={profile} currentStoreId={realtimeStoreId}>
            <SettingsFrame
              area={SettingsAreas.ACCOUNT}
              entries={ACCOUNT_SETTINGS_ENTRIES}
              backTo={inboxPath === null ? null : { href: inboxPath, label: t('backToInbox') }}
            >
              {children}
            </SettingsFrame>
          </AppFrame>
        )
        // Always the same element, so a profile that gains or loses the store never remounts the page
        return (
          <RealtimeProvider storeId={realtimeStoreId} userId={profile.id} leaveWhenRefused={false}>
            {frame}
          </RealtimeProvider>
        )
      }}
    </SessionGate>
  )
}
