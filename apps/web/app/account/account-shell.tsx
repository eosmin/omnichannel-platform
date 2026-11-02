'use client'

import type { ReactElement, ReactNode } from 'react'

import { SettingsFrame } from '../../components/settings/settings-frame'
import { AppFrame } from '../../components/shell/app-frame'
import { SessionGate } from '../../components/shell/session-gate'
import { readLastStoreId } from '../../lib/last-store'
import { ACCOUNT_SETTINGS_ENTRIES, SettingsAreas } from '../../lib/settings/entries'

export function AccountShell({ children }: { children: ReactNode }): ReactElement {
  return (
    <SessionGate>
      {profile => (
        <AppFrame profile={profile} currentStoreId={readLastStoreId()}>
          <SettingsFrame area={SettingsAreas.ACCOUNT} entries={ACCOUNT_SETTINGS_ENTRIES}>
            {children}
          </SettingsFrame>
        </AppFrame>
      )}
    </SessionGate>
  )
}
