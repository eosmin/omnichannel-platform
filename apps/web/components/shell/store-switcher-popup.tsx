'use client'

import { Check } from 'lucide-react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import type { ReactElement } from 'react'

import { type AccountMembership, AppPaths } from '@platform/api-client'
import { ClientPermissions } from '@platform/core/auth'

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '../ui/dropdown-menu'

// The menu of the store button, downloaded when the person reaches for the button (`StoreSwitcher`)
export default function StoreSwitcherPopup({
  memberships,
  suspendedStores,
  currentStoreId,
  defaultOpen,
  trigger
}: {
  memberships: readonly AccountMembership[]
  suspendedStores: readonly { storeId: string; storeName: string }[]
  currentStoreId: string | null
  defaultOpen: boolean
  trigger: ReactElement
}): ReactElement {
  const t = useTranslations('shell')
  const canManageStores = memberships.some(membership =>
    membership.permissions.includes(ClientPermissions.ORG_MANAGE_STORES)
  )
  // The warehouses belong to the organization, not to a store: whoever may see the inventory of any store reaches
  // them from here
  const canSeeWarehouses = memberships.some(membership =>
    membership.permissions.includes(ClientPermissions.INVENTORY_VIEW)
  )
  return (
    <DropdownMenu defaultOpen={defaultOpen}>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
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
        {suspendedStores.map(store => (
          <DropdownMenuItem key={store.storeId} disabled>
            <span className="flex-1 truncate">{store.storeName}</span>
            <span className="text-muted-foreground text-xs">{t('accessSuspended')}</span>
          </DropdownMenuItem>
        ))}
        {(canManageStores || canSeeWarehouses) && <DropdownMenuSeparator />}
        {canManageStores && (
          <DropdownMenuItem asChild>
            <Link href={AppPaths.org.stores}>{t('manageStores')}</Link>
          </DropdownMenuItem>
        )}
        {canSeeWarehouses && (
          <DropdownMenuItem asChild>
            <Link href={AppPaths.org.warehouses}>{t('warehouses')}</Link>
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
