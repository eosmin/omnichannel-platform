'use client'

import type { ReactElement, ReactNode } from 'react'

import { RealtimeProvider } from '../../components/providers/realtime-provider'
import { SettingsFrame } from '../../components/settings/settings-frame'
import { AppFrame } from '../../components/shell/app-frame'
import { SessionGate } from '../../components/shell/session-gate'
import { accountRealtimeStoreId } from '../../lib/account-realtime-store'
import { readLastStoreId } from '../../lib/last-store'
import { ACCOUNT_SETTINGS_ENTRIES, SettingsAreas } from '../../lib/settings/entries'

export function AccountShell({ children }: { children: ReactNode }): ReactElement {
  return (
    <SessionGate>
      {profile => {
        // The bell and the socket follow the same store: the last one the person still belongs to
        const realtimeStoreId = accountRealtimeStoreId(profile, readLastStoreId())
        const frame = (
          <AppFrame profile={profile} currentStoreId={realtimeStoreId}>
            <SettingsFrame area={SettingsAreas.ACCOUNT} entries={ACCOUNT_SETTINGS_ENTRIES}>
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
