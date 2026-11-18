'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { type ReactElement, useEffect, useRef } from 'react'

import { AppPaths } from '@platform/api-client'
import { ClientPermissions } from '@platform/core/auth'

import { mayOpenExports } from '../../lib/exports/export-state'
import { bestFinanceMembership, mayOpenFinance } from '../../lib/finance/area'
import { mayOpenStoreSettings } from '../../lib/settings/may-open-settings'
import { useProfile } from '../../lib/use-profile'
import { cn } from '../../lib/utils'
import { useStore } from '../providers/store-context'

// The pages of the store that exist, for who may open them.  Settings is shown when the person may open at least one of its pages.
export function StoreNav(): ReactElement {
  const t = useTranslations('shell.nav')
  const { storeId, can } = useStore()
  const pathname = usePathname()
  const profile = useProfile()
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
      href: AppPaths.store.shipments(storeId),
      label: t('shipments'),
      isShown: can(ClientPermissions.SHIPPING_VIEW)
    },
    {
      href: AppPaths.store.pickups(storeId),
      label: t('pickups'),
      isShown: can(ClientPermissions.SHIPPING_VIEW)
    },
    {
      href: AppPaths.store.returns(storeId),
      label: t('returns'),
      isShown: can(ClientPermissions.RETURNS_VIEW)
    },
    {
      href: AppPaths.store.remittances(storeId),
      label: t('remittances'),
      isShown: can(ClientPermissions.REMITTANCES_VIEW)
    },
    {
      href: AppPaths.store.inventory(storeId),
      label: t('inventory'),
      isShown: can(ClientPermissions.INVENTORY_VIEW)
    },
    {
      href: AppPaths.store.analytics(storeId),
      label: t('analytics'),
      isShown: can(ClientPermissions.ANALYTICS_VIEW)
    },
    {
      href: AppPaths.store.exports(storeId),
      label: t('exports'),
      isShown: mayOpenExports(can)
    },
    {
      href: AppPaths.finance.home,
      label: t('finance'),
      // The area opens through the store where the person holds most of the finance permissions, not only through this one
      isShown:
        mayOpenFinance(can) || bestFinanceMembership(profile.data?.memberships ?? []) !== undefined
    },
    {
      href: AppPaths.store.settings(storeId),
      // Any page of the area keeps the entry current
      match: `/s/${storeId}/settings`,
      label: t('settings'),
      isShown: mayOpenStoreSettings(can)
    }
  ].filter(entry => entry.isShown)
  const nav = useRef<HTMLElement>(null)
  // On a phone the links are one row that scrolls (four rows over the thread left no room to read it, N-BR2-63).
  // The row opens with the current page in view, and its end has room so that the last link can scroll clear
  // of the fade that tells the person there is more (a row cut with no sign cut a word: "Custome").
  const current = entries.find(entry => pathname.startsWith(entry.match ?? entry.href))?.href
  useEffect(() => {
    const row = nav.current
    if (row === null || current === undefined) return
    const link = Array.from(row.querySelectorAll('a')).find(
      item => item.getAttribute('aria-current') === 'page'
    )
    if (link === undefined || row.scrollWidth <= row.clientWidth) return
    row.scrollTo({ left: link.offsetLeft - row.clientWidth / 2 + link.clientWidth / 2 })
  }, [current])
  return (
    <nav
      ref={nav}
      aria-label={t('label')}
      className="relative flex min-w-0 items-center gap-1 overflow-x-auto max-md:[mask-image:linear-gradient(to_right,black_calc(100%-2rem),transparent)] max-md:pe-8"
    >
      {entries.map(entry => {
        const isCurrent = pathname.startsWith(entry.match ?? entry.href)
        return (
          <Link
            key={entry.href}
            href={entry.href}
            aria-current={isCurrent ? 'page' : undefined}
            className={cn(
              'hover:bg-accent inline-flex shrink-0 items-center rounded-md px-2 py-1 text-sm whitespace-nowrap pointer-coarse:min-h-11',
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
