'use client'

import { usePathname } from 'next/navigation'
import { useTranslations } from 'next-intl'
import type { ReactElement, ReactNode } from 'react'

import type { AccountProfile } from '@platform/api-client'

import { isInboxPath } from '../../lib/inbox/inbox-route'
import { cn } from '../../lib/utils'

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
  const isInbox = isInboxPath(usePathname())
  return (
    <div
      className={cn(
        'flex flex-col',
        // The inbox is exactly the window and the page never scrolls (`clip`, not `hidden`: a box that is
        // `hidden` can still be scrolled by the browser to reveal a focused field, and not scrolled back)
        isInbox ? 'h-dvh overflow-clip' : 'min-h-dvh'
      )}
    >
      <TopBar profile={profile} currentStoreId={currentStoreId} appTitle={t('title')} nav={nav} />
      <LocaleSync savedLocale={profile.locale} />
      <DensitySync density={profile.density} />
      <ConnectionIndicator />
      <main className={cn('flex-1', isInbox ? 'flex min-h-0' : 'compact:p-2 p-4')}>{children}</main>
    </div>
  )
}
