'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useTranslations } from 'next-intl'
import type { ReactElement } from 'react'

import { AppPaths } from '@platform/api-client'
import { Permissions } from '@platform/core/auth'

import { mayOpenExports } from '../../lib/exports/export-state'
import { mayOpenStoreSettings } from '../../lib/settings/may-open-settings'
import { cn } from '../../lib/utils'
import { useStore } from '../providers/store-context'

// The pages of the store that exist, for who may open them. Orders and Analytics join with Steps 4.4
// and 5.2. Settings is shown when the person may open at least one of its pages.
export function StoreNav(): ReactElement {
  const t = useTranslations('shell.nav')
  const { storeId, can } = useStore()
  const pathname = usePathname()
  const entries = [
    {
      href: AppPaths.store.inbox(storeId),
      label: t('inbox'),
      isShown: can(Permissions.CONVERSATIONS_VIEW)
    },
    {
      href: AppPaths.store.customers(storeId),
      label: t('customers'),
      isShown: can(Permissions.CUSTOMERS_VIEW)
    },
    {
      href: AppPaths.store.exports(storeId),
      label: t('exports'),
      isShown: mayOpenExports(can)
    },
    {
      href: AppPaths.store.settings(storeId),
      // Any page of the area keeps the entry current
      match: `/s/${storeId}/settings`,
      label: t('settings'),
      isShown: mayOpenStoreSettings(can)
    }
  ].filter(entry => entry.isShown)
  return (
    <nav aria-label={t('label')} className="flex items-center gap-1">
      {entries.map(entry => {
        const isCurrent = pathname.startsWith(entry.match ?? entry.href)
        return (
          <Link
            key={entry.href}
            href={entry.href}
            aria-current={isCurrent ? 'page' : undefined}
            className={cn(
              'hover:bg-accent rounded-md px-2 py-1 text-sm',
              isCurrent ? 'font-semibold' : 'text-muted-foreground'
            )}
          >
            {entry.label}
          </Link>
        )
      })}
    </nav>
  )
}
