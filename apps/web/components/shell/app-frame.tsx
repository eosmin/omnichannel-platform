'use client'

import { useTranslations } from 'next-intl'
import type { ReactElement, ReactNode } from 'react'

import type { AccountProfile } from '@platform/api-client'

import { ConnectionIndicator } from './connection-indicator'
import { DensitySync } from './density-sync'
import { LocaleSync } from './locale-sync'
import { TopBar } from './top-bar'

// The top bar over the content of an area. The area decides what the content is.
export function AppFrame({
  profile,
  currentStoreId,
  nav,
  children
}: {
  profile: AccountProfile
  currentStoreId: string | null
  nav?: ReactNode
  children: ReactNode
}): ReactElement {
  const t = useTranslations('app')
  return (
    <div className="flex min-h-dvh flex-col">
      <TopBar profile={profile} currentStoreId={currentStoreId} appTitle={t('title')} nav={nav} />
      <LocaleSync savedLocale={profile.locale} />
      <DensitySync density={profile.density} />
      <ConnectionIndicator />
      <main className="compact:p-2 flex-1 p-4">{children}</main>
    </div>
  )
}
