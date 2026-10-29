'use client'

import type { ReactElement, ReactNode } from 'react'

import { AppFrame } from '../../components/shell/app-frame'
import { SessionGate } from '../../components/shell/session-gate'
import { readLastStoreId } from '../../lib/last-store'

export function AccountShell({ children }: { children: ReactNode }): ReactElement {
  return (
    <SessionGate>
      {profile => (
        <AppFrame profile={profile} currentStoreId={readLastStoreId()}>
          {children}
        </AppFrame>
      )}
    </SessionGate>
  )
}
