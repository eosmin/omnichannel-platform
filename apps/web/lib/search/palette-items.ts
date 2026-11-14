import { AppPaths } from '@platform/api-client'
import { ClientPermissions, type Permission } from '@platform/core/auth'
import { foldForSearch } from '@platform/core/domain'

import { type SearchHit, pathOfHit } from './hits'

// The pages the palette can jump to, for who may open them. `labelKey` is a message of `shell.nav`.
export interface PageCommand {
  id: string
  labelKey: 'inbox' | 'customers' | 'products' | 'orders' | 'inventory'
  href: string
}

export function pageCommands(
  storeId: string,
  can: (permission: Permission) => boolean
): PageCommand[] {
  const all: (PageCommand & { isShown: boolean })[] = [
    {
      id: 'inbox',
      labelKey: 'inbox',
      href: AppPaths.store.inbox(storeId),
      isShown: can(ClientPermissions.CONVERSATIONS_VIEW)
    },
    {
      id: 'customers',
      labelKey: 'customers',
      href: AppPaths.store.customers(storeId),
      isShown: can(ClientPermissions.CUSTOMERS_VIEW)
    },
    {
      id: 'orders',
      labelKey: 'orders',
      href: AppPaths.store.orders(storeId),
      isShown: can(ClientPermissions.ORDERS_VIEW)
    },
    {
      id: 'products',
      labelKey: 'products',
      href: AppPaths.store.products(storeId),
      isShown: can(ClientPermissions.PRODUCTS_VIEW)
    },
    {
      id: 'inventory',
      labelKey: 'inventory',
      href: AppPaths.store.inventory(storeId),
      isShown: can(ClientPermissions.INVENTORY_VIEW)
    }
  ]
  return all.filter(command => command.isShown).map(({ isShown: _shown, ...command }) => command)
}

// What a row of the palette opens
export type PaletteItem =
  | { kind: 'page'; key: string; label: string; href: string }
  | { kind: 'hit'; key: string; item: SearchHit; href: string | null }
  | { kind: 'all'; key: string; href: string }

// The commands whose label holds the text (no accents, any case); all of them for no text
export function matchingPages(
  commands: readonly PageCommand[],
  labelOf: (command: PageCommand) => string,
  text: string
): PaletteItem[] {
  const wanted = foldForSearch(text)
  return commands
    .map(command => ({ command, label: labelOf(command) }))
    .filter(({ label }) => wanted === '' || foldForSearch(label).includes(wanted))
    .map(({ command, label }) => ({
      kind: 'page' as const,
      key: `page:${command.id}`,
      label,
      href: command.href
    }))
}

export function hitItems(
  storeId: string,
  hits: readonly SearchHit[],
  keyOf: (hit: SearchHit) => string
): PaletteItem[] {
  return hits.map(item => ({
    kind: 'hit' as const,
    key: keyOf(item),
    item,
    href: pathOfHit(storeId, item)
  }))
}

// The arrow keys wrap around the list; an empty list has no active row
export function moveActive(current: number, step: 1 | -1, length: number): number {
  if (length === 0) return -1
  if (current < 0) return step === 1 ? 0 : length - 1
  return (current + step + length) % length
}
