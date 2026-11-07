'use client'

import { useRouter } from 'next/navigation'

import { AppPaths } from '@platform/api-client'
import { ClientPermissions } from '@platform/core/auth'
import { Shortcuts } from '@platform/core/domain'

import { askSearchFocus } from '../../lib/customers/search-focus'
import { useStore } from '../providers/store-context'

import { useShortcut } from './shortcuts-provider'

// The jumps between the pages of the store (`g i`, `g c`, TDD_09 §9). `inboxSearch` is the filter of
// the inbox ("?status=..."), kept when the jump comes from the inbox. Used inside a ShortcutsProvider.
// A jump is offered only to who may open the page it goes to. `Mod+K` stands for the command palette of
// Step 5.1; until it exists it takes the person to the search of customers (the page focuses its box when
// it opens), or, on that page, `focusSearch` puts the cursor in the box.
export function useGoToShortcuts(inboxSearch = '', focusSearch?: () => void): void {
  const router = useRouter()
  const { storeId, can } = useStore()
  useShortcut(Shortcuts.global.GO_TO_INBOX, () =>
    router.push(`${AppPaths.store.inbox(storeId)}${inboxSearch}`)
  )
  useShortcut(
    Shortcuts.global.COMMAND_PALETTE,
    () => {
      if (focusSearch !== undefined) focusSearch()
      else {
        askSearchFocus()
        router.push(AppPaths.store.customers(storeId))
      }
    },
    { enabled: can(ClientPermissions.CUSTOMERS_VIEW) }
  )
  useShortcut(
    Shortcuts.global.GO_TO_CUSTOMERS,
    () => router.push(AppPaths.store.customers(storeId)),
    {
      enabled: can(ClientPermissions.CUSTOMERS_VIEW)
    }
  )
}
