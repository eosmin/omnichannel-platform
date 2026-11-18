'use client'

import { Menu } from 'lucide-react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useTranslations } from 'next-intl'
import type { ReactElement } from 'react'

import { AppPaths } from '@platform/api-client'
import { ClientPermissions } from '@platform/core/auth'

import { mayOpenExports } from '../../lib/exports/export-state'
import { bestFinanceMembership, mayOpenFinance } from '../../lib/finance/area'
import { mayOpenStoreSettings } from '../../lib/settings/may-open-settings'
import { useProfile } from '../../lib/use-profile'
import { cn } from '../../lib/utils'
import { useStore } from '../providers/store-context'
import { Button } from '../ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '../ui/dropdown-menu'

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
  const currentEntry = entries.find(entry => pathname.startsWith(entry.match ?? entry.href))
  // From `md` the links are a row that scrolls if it ever overflows. On a phone they are one button with the page
  // the person is on, and the links open under it: four rows of links over the thread left no room to read it
  // (N-BR2-63), and one row that scrolls cut a word ("Custome"), so neither shows a link cut by an edge.
  return (
    <>
      <nav
        aria-label={t('label')}
        className="hidden min-w-0 items-center gap-1 overflow-x-auto md:flex"
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
      <nav aria-label={t('label')} className="min-w-0 md:hidden">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" className="max-w-full px-2">
              <Menu aria-hidden />
              <span className="truncate">{currentEntry?.label ?? t('menu')}</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {entries.map(entry => (
              <DropdownMenuItem key={entry.href} asChild className="min-h-11">
                <Link
                  href={entry.href}
                  aria-current={entry === currentEntry ? 'page' : undefined}
                  className={entry === currentEntry ? 'font-semibold' : undefined}
                >
                  {entry.label}
                </Link>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </nav>
    </>
  )
}
