'use client'

import { Check, ChevronsUpDown } from 'lucide-react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import type { ReactElement } from 'react'

import { type AccountMembership, AppPaths } from '@platform/api-client'
import { Permissions } from '@platform/core/auth'

import { Button } from '../ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '../ui/dropdown-menu'

// The stores of the person, each with its name and their role there. No count of open
// conversations: it would take a call for each store (Phase 2, MVP_TRIM_CHECKLIST §10 item 39).
export function StoreSwitcher({
  memberships,
  currentStoreId
}: {
  memberships: readonly AccountMembership[]
  currentStoreId: string | null
}): ReactElement | null {
  const t = useTranslations('shell')
  if (memberships.length === 0) return null
  const current = memberships.find(membership => membership.storeId === currentStoreId)
  const canManageStores = memberships.some(membership =>
    membership.permissions.includes(Permissions.ORG_MANAGE_STORES)
  )
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" aria-label={t('switchStore')}>
          <span className="max-w-40 truncate">{current?.storeName ?? t('selectStore')}</span>
          <ChevronsUpDown aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuLabel>{t('stores')}</DropdownMenuLabel>
        {memberships.map(membership => (
          <DropdownMenuItem key={membership.storeId} asChild>
            <Link href={AppPaths.store.inbox(membership.storeId)}>
              <span className="flex-1 truncate">{membership.storeName}</span>
              <span className="text-muted-foreground text-xs">{membership.role}</span>
              {membership.storeId === currentStoreId && <Check aria-hidden className="size-4" />}
            </Link>
          </DropdownMenuItem>
        ))}
        {canManageStores && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              <Link href={AppPaths.org.stores}>{t('manageStores')}</Link>
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
