'use client'

import { useRouter } from 'next/navigation'

import { AppPaths } from '@platform/api-client'
import { ClientPermissions } from '@platform/core/auth'
import { Shortcuts } from '@platform/core/domain'

import { useStore } from '../providers/store-context'

import { useShortcut } from './shortcuts-provider'

// The jumps between the pages of the store (`g i`, `g o`, `g c`, TDD_09 §9). `inboxSearch` is the filter of
// the inbox ("?status=..."), kept when the jump comes from the inbox. Used inside a ShortcutsProvider.
// A jump is offered only to who may open the page it goes to. `Mod+K` is not here: the palette of Step 5.1 is
// registered once for every page of the store (`SearchProvider`).
export function useGoToShortcuts(inboxSearch = ''): void {
  const router = useRouter()
  const { storeId, can } = useStore()
  useShortcut(Shortcuts.global.GO_TO_INBOX, () =>
    router.push(`${AppPaths.store.inbox(storeId)}${inboxSearch}`)
  )
  useShortcut(Shortcuts.global.GO_TO_ORDERS, () => router.push(AppPaths.store.orders(storeId)), {
    enabled: can(ClientPermissions.ORDERS_VIEW)
  })
  useShortcut(
    Shortcuts.global.GO_TO_CUSTOMERS,
    () => router.push(AppPaths.store.customers(storeId)),
    {
      enabled: can(ClientPermissions.CUSTOMERS_VIEW)
    }
  )
}
