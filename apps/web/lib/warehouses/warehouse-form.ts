import { ApiError } from '@platform/api-client'
import type {
  CreateWarehouseInput,
  UpdateWarehouseInput,
  WarehouseAddressInput,
  WarehouseDetailView,
  WarehouseStoreLink,
  WarehouseStoreLinkInput
} from '@platform/api-client'
import {
  InventoryLimits,
  WarehouseConflicts,
  WarehouseLimits,
  WarehouseStockBlocks
} from '@platform/core/domain'

// The form of a warehouse (TDD_16 §6, TDD_09 §16): what is typed, what is wrong with it, and what changed.

export interface WarehouseDraft {
  name: string
  code: string
  line1: string
  line2: string
  city: string
  state: string
  postalCode: string
  country: string
}

export const WarehouseFields = {
  NAME: 'name',
  CODE: 'code',
  LINE1: 'line1',
  CITY: 'city',
  COUNTRY: 'country'
} as const
export type WarehouseField = (typeof WarehouseFields)[keyof typeof WarehouseFields]

export const emptyWarehouseDraft = (): WarehouseDraft => ({
  name: '',
  code: '',
  line1: '',
  line2: '',
  city: '',
  state: '',
  postalCode: '',
  country: ''
})

export function warehouseDraftOf(warehouse: WarehouseDetailView): WarehouseDraft {
  const address = warehouse.address ?? {}
  return {
    name: warehouse.name,
    code: warehouse.code,
    line1: address['line1'] ?? '',
    line2: address['line2'] ?? '',
    city: address['city'] ?? '',
    state: address['state'] ?? '',
    postalCode: address['postalCode'] ?? '',
    country: address['country'] ?? ''
  }
}

const ADDRESS_KEYS = ['line1', 'line2', 'city', 'state', 'postalCode', 'country'] as const

const trimmed = (draft: WarehouseDraft): WarehouseDraft => ({
  name: draft.name.trim(),
  code: draft.code.trim(),
  line1: draft.line1.trim(),
  line2: draft.line2.trim(),
  city: draft.city.trim(),
  state: draft.state.trim(),
  postalCode: draft.postalCode.trim(),
  country: draft.country.trim().toUpperCase()
})

const hasAddress = (draft: WarehouseDraft): boolean => ADDRESS_KEYS.some(key => draft[key] !== '')

// The first field that cannot be sent, or null. An address is all or nothing: its first line and its city are
// required as soon as any part of it is typed.
export function warehouseProblem(input: WarehouseDraft): WarehouseField | null {
  const draft = trimmed(input)
  if (draft.name === '' || draft.name.length > InventoryLimits.WAREHOUSE_NAME_MAX_LENGTH) {
    return WarehouseFields.NAME
  }
  if (!WarehouseLimits.CODE_PATTERN.test(draft.code)) return WarehouseFields.CODE
  if (hasAddress(draft)) {
    if (draft.line1 === '') return WarehouseFields.LINE1
    if (draft.city === '') return WarehouseFields.CITY
    if (draft.country !== '' && !/^[A-Z]{2}$/.test(draft.country)) return WarehouseFields.COUNTRY
  }
  return null
}

function addressOf(draft: WarehouseDraft): WarehouseAddressInput | null {
  if (!hasAddress(draft)) return null
  const address: WarehouseAddressInput = { line1: draft.line1, city: draft.city }
  if (draft.line2 !== '') address.line2 = draft.line2
  if (draft.state !== '') address.state = draft.state
  if (draft.postalCode !== '') address.postalCode = draft.postalCode
  if (draft.country !== '') address.country = draft.country
  return address
}

export function createInputOf(input: WarehouseDraft): CreateWarehouseInput {
  const draft = trimmed(input)
  const address = addressOf(draft)
  return {
    name: draft.name,
    code: draft.code,
    ...(address === null ? {} : { address })
  }
}

// Only what the person changed: the api takes a PATCH, and a null address clears it
export function updateInputOf(
  saved: WarehouseDetailView,
  input: WarehouseDraft
): UpdateWarehouseInput {
  const draft = trimmed(input)
  const before = trimmed(warehouseDraftOf(saved))
  const changes: UpdateWarehouseInput = {}
  if (draft.name !== before.name) changes.name = draft.name
  if (draft.code !== before.code) changes.code = draft.code
  if (ADDRESS_KEYS.some(key => draft[key] !== before[key])) changes.address = addressOf(draft)
  return changes
}

// The stores of a warehouse and its priority in each (TDD_16 §6) --------------------------------------------------
// The priority belongs to a store: it is where THIS warehouse stands in the list of warehouses that store reserves
// from (1 is reserved first). The stores of one warehouse have no order among themselves.

// The list the editor works on, by store name so that it does not jump when a priority changes
export const linksOf = (warehouse: WarehouseDetailView): WarehouseStoreLink[] =>
  [...warehouse.stores].sort(
    (a, b) => a.storeName.localeCompare(b.storeName) || a.storeId.localeCompare(b.storeId)
  )

// How many warehouses a store reserves from, this one included: the last place a priority can take. A store the
// warehouse does not serve yet counts the warehouse too, because linking puts it at the end.
export function placesOf(
  warehouses: readonly WarehouseDetailView[],
  warehouse: WarehouseDetailView
): ReadonlyMap<string, number> {
  const others = new Map<string, number>()
  for (const other of warehouses) {
    if (other.id === warehouse.id) continue
    for (const link of other.stores) others.set(link.storeId, (others.get(link.storeId) ?? 0) + 1)
  }
  return new Map([...others].map(([storeId, count]) => [storeId, count + 1]))
}

export const placesIn = (places: ReadonlyMap<string, number>, storeId: string): number =>
  places.get(storeId) ?? 1

// The links as the screen shows and sends them: a priority above the last place of its store (the list of that
// store got shorter while the person was editing) stands at the last place, which is where the api would put it
export const fitLinks = (
  links: readonly WarehouseStoreLink[],
  places: ReadonlyMap<string, number>
): WarehouseStoreLink[] =>
  links.map(link => ({
    ...link,
    priority: Math.min(link.priority, placesIn(places, link.storeId))
  }))

// One place earlier (-1) or later (+1) in that store's list, never outside it
export function moveLink(
  links: readonly WarehouseStoreLink[],
  storeId: string,
  direction: -1 | 1,
  places: ReadonlyMap<string, number>
): WarehouseStoreLink[] {
  return links.map(link =>
    link.storeId === storeId
      ? {
          ...link,
          priority: Math.min(Math.max(link.priority + direction, 1), placesIn(places, storeId))
        }
      : link
  )
}

export const removeLink = (
  links: readonly WarehouseStoreLink[],
  storeId: string
): WarehouseStoreLink[] => links.filter(link => link.storeId !== storeId)

// A store that is added goes to the end of its list, as the api puts a new link
export function addLink(
  links: readonly WarehouseStoreLink[],
  store: { storeId: string; storeName: string },
  places: ReadonlyMap<string, number>
): WarehouseStoreLink[] {
  if (links.some(link => link.storeId === store.storeId)) return [...links]
  return [...links, { ...store, priority: placesIn(places, store.storeId) }].sort(
    (a, b) => a.storeName.localeCompare(b.storeName) || a.storeId.localeCompare(b.storeId)
  )
}

// Every priority is sent: the screen shows the place the person chose in each store
export const linkInputsOf = (links: readonly WarehouseStoreLink[]): WarehouseStoreLinkInput[] =>
  links.map(link => ({ storeId: link.storeId, priority: link.priority }))

export function linksChanged(
  saved: readonly WarehouseStoreLink[],
  draft: readonly WarehouseStoreLink[]
): boolean {
  if (saved.length !== draft.length) return true
  const before = new Map(saved.map(link => [link.storeId, link.priority]))
  return draft.some(link => before.get(link.storeId) !== link.priority)
}

// The stores a person may add: those of the organization that the warehouse does not serve yet
export function addableStores<T extends { id: string }>(
  stores: readonly T[],
  links: readonly WarehouseStoreLink[]
): T[] {
  const linked = new Set(links.map(link => link.storeId))
  return stores.filter(store => !linked.has(store.id))
}

// Why the api refused to switch off or unlink a warehouse (INVENTORY_WAREHOUSE_HAS_STOCK, `metadata.reason`)
export const StockBlockKeys = {
  [WarehouseStockBlocks.DEACTIVATE]: 'deactivate',
  [WarehouseStockBlocks.UNLINK]: 'unlink',
  [WarehouseStockBlocks.OPEN_TRANSFER]: 'openTransfer'
} as const
export type StockBlockKey = (typeof StockBlockKeys)[keyof typeof StockBlockKeys]

export function stockBlockKeyOf(error: unknown): StockBlockKey | null {
  if (!(error instanceof ApiError)) return null
  const reason = error.metadata['reason']
  if (typeof reason !== 'string') return null
  return Object.entries(StockBlockKeys).find(([value]) => value === reason)?.[1] ?? null
}

// A 409 that says another warehouse has the code (`metadata.conflict`), so the code box can say so
export const isCodeInUse = (error: unknown): boolean =>
  error instanceof ApiError && error.metadata['conflict'] === WarehouseConflicts.CODE_IN_USE
