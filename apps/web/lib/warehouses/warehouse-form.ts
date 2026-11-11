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

// The stores of a warehouse, in the order they are reserved from -------------------------------------------------

// The list the editor works on: the stores the warehouse serves, the first one reserved first
export const linksOf = (warehouse: WarehouseDetailView): WarehouseStoreLink[] =>
  warehouse.stores.map((link, index) => ({ ...link, priority: index + 1 }))

export function moveLink(
  links: readonly WarehouseStoreLink[],
  index: number,
  direction: -1 | 1
): WarehouseStoreLink[] {
  const target = index + direction
  if (index < 0 || index >= links.length || target < 0 || target >= links.length) return [...links]
  const next = [...links]
  const [moved] = next.splice(index, 1)
  if (moved === undefined) return [...links]
  next.splice(target, 0, moved)
  return next.map((link, position) => ({ ...link, priority: position + 1 }))
}

export const removeLink = (
  links: readonly WarehouseStoreLink[],
  storeId: string
): WarehouseStoreLink[] =>
  links
    .filter(link => link.storeId !== storeId)
    .map((link, position) => ({ ...link, priority: position + 1 }))

// A store that is added goes to the end of the list, as the api puts a new link
export function addLink(
  links: readonly WarehouseStoreLink[],
  store: { storeId: string; storeName: string }
): WarehouseStoreLink[] {
  if (links.some(link => link.storeId === store.storeId)) return [...links]
  return [...links, { ...store, priority: links.length + 1 }]
}

// Every priority is sent: the list on the screen is the one the person arranged
export const linkInputsOf = (links: readonly WarehouseStoreLink[]): WarehouseStoreLinkInput[] =>
  links.map((link, index) => ({ storeId: link.storeId, priority: index + 1 }))

export function linksChanged(
  saved: readonly WarehouseStoreLink[],
  draft: readonly WarehouseStoreLink[]
): boolean {
  return (
    saved.length !== draft.length ||
    saved.some((link, index) => link.storeId !== draft[index]?.storeId)
  )
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
