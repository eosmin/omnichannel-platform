export interface WarehouseStoreLinkView {
  storeId: string
  storeName: string
  priority: number
}

export interface WarehouseView {
  id: string
  name: string
  code: string
  address: Record<string, string> | null
  active: boolean
  stores: WarehouseStoreLinkView[]
  createdAt: Date
  updatedAt: Date
}

export interface WarehousePage {
  data: WarehouseView[]
  nextCursor: string | null
  hasMore: boolean
}

export const WAREHOUSE_SELECT = {
  id: true,
  name: true,
  code: true,
  address: true,
  active: true,
  createdAt: true,
  updatedAt: true,
  stores: {
    select: { storeId: true, priority: true, store: { select: { name: true } } }
  }
} as const

interface WarehouseRow {
  id: string
  name: string
  code: string
  address: unknown
  active: boolean
  createdAt: Date
  updatedAt: Date
  stores: { storeId: string; priority: number; store: { name: string } }[]
}

// The address column holds what the schema of the body let through: an object of text fields, or nothing
function addressOf(value: unknown): Record<string, string> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
  )
}

export function warehouseView(row: WarehouseRow): WarehouseView {
  return {
    id: row.id,
    name: row.name,
    code: row.code,
    address: addressOf(row.address),
    active: row.active,
    // In the order they are reserved from: the first priority first
    stores: [...row.stores]
      .sort((a, b) => a.priority - b.priority || a.storeId.localeCompare(b.storeId))
      .map(link => ({
        storeId: link.storeId,
        storeName: link.store.name,
        priority: link.priority
      })),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  }
}
