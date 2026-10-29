'use client'

import { useTranslations } from 'next-intl'
import type { ReactElement, ReactNode } from 'react'

import type { AccountProfile } from '@platform/api-client'

import { ConnectionIndicator } from './connection-indicator'
import { TopBar } from './top-bar'

// The top bar over the content of an area. The area decides what the content is.
export function AppFrame({
  profile,
  currentStoreId,
  children
}: {
  profile: AccountProfile
  currentStoreId: string | null
  children: ReactNode
}): ReactElement {
  const t = useTranslations('app')
  return (
    <div className="flex min-h-dvh flex-col">
      <TopBar profile={profile} currentStoreId={currentStoreId} appTitle={t('title')} />
      <ConnectionIndicator />
      <main className="flex-1 p-4">{children}</main>
    </div>
  )
}
