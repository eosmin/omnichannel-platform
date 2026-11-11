'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useTranslations } from 'next-intl'
import type { ReactElement } from 'react'

import { AppPaths } from '@platform/api-client'
import { ClientPermissions } from '@platform/core/auth'

import { mayOpenExports } from '../../lib/exports/export-state'
import { mayOpenStoreSettings } from '../../lib/settings/may-open-settings'
import { cn } from '../../lib/utils'
import { useStore } from '../providers/store-context'

// The pages of the store that exist, for who may open them. Analytics joins with Step 5.2. Settings is shown when the person may open at least one of its pages.
export function StoreNav(): ReactElement {
  const t = useTranslations('shell.nav')
  const { storeId, can } = useStore()
  const pathname = usePathname()
  const entries = [
    {
      href: AppPaths.store.inbox(storeId),
      label: t('inbox'),
      isShown: can(ClientPermissions.CONVERSATIONS_VIEW)
    },
    {
      href: AppPaths.store.customers(storeId),
      label: t('customers'),
      isShown: can(ClientPermissions.CUSTOMERS_VIEW)
    },
    {
      href: AppPaths.store.products(storeId),
      label: t('products'),
      isShown: can(ClientPermissions.PRODUCTS_VIEW)
    },
    {
      href: AppPaths.store.orders(storeId),
      label: t('orders'),
      isShown: can(ClientPermissions.ORDERS_VIEW)
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
  // On a phone the links wrap onto a second line instead of scrolling: five of them do not fit one line at
  // 360 px, and a scrolling row cut a word ("Custome"). From `md` they scroll if they ever overflow.
  return (
    <nav
      aria-label={t('label')}
      className="flex min-w-0 items-center gap-1 max-md:flex-wrap md:overflow-x-auto"
    >
      {entries.map(entry => {
        const isCurrent = pathname.startsWith(entry.match ?? entry.href)
        return (
          <Link
            key={entry.href}
            href={entry.href}
            aria-current={isCurrent ? 'page' : undefined}
            className={cn(
              'hover:bg-accent inline-flex shrink-0 items-center rounded-md px-2 py-1 text-sm whitespace-nowrap pointer-coarse:min-h-10',
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
