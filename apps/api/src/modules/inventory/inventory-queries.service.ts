import { Injectable } from '@nestjs/common'

import { PrismaService } from '@platform/core/database'
import { resourceNotFound } from '@platform/core/errors'

import { encodeCursor } from '../customers/list-cursor'

import type { KardexQuery, ListLevelsQuery, ListMovementsQuery } from './inventory.schemas'
import {
  LEVEL_SELECT,
  type LevelPage,
  levelView,
  MOVEMENT_SELECT,
  type MovementPage,
  movementView,
  type ProductInventory
} from './inventory.views'

// The most products a "low stock" filter looks at: a store whose catalog is mostly low is paged by the other filters
const LOW_STOCK_PRODUCTS_MAX = 5000

// Stock of the store of the request, read-only. Every query names the store (TenantGuard) and nothing else decides it.
// `canSeeCost` is whether the caller holds products:view_cost: without it the cost fields are left out of the views.
@Injectable()
export class InventoryQueriesService {
  constructor(private readonly prisma: PrismaService) {}

  async listLevels(
    storeId: string,
    query: ListLevelsQuery,
    canSeeCost: boolean
  ): Promise<LevelPage> {
    const { cursor } = query
    const lowStockProducts =
      query.lowStock === true ? await this.productsAtTheirThreshold(storeId) : null
    const rows = await this.prisma.client.inventoryLevel.findMany({
      where: {
        storeId,
        ...(query.warehouseId === undefined ? {} : { warehouseId: query.warehouseId }),
        ...(query.productId === undefined ? {} : { productId: query.productId }),
        ...(query.variantId === undefined ? {} : { variantId: query.variantId }),
        ...(lowStockProducts === null ? {} : { productId: { in: lowStockProducts } }),
        // After the last row of the previous page in (updatedAt, id) order, wherever that row is now
        ...(cursor === undefined
          ? {}
          : {
              OR: [
                { updatedAt: { lt: cursor.createdAt } },
                { updatedAt: cursor.createdAt, id: { lt: cursor.id } }
              ]
            })
      },
      select: LEVEL_SELECT,
      take: query.limit + 1,
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }]
    })
    const hasMore = rows.length > query.limit
    const page = hasMore ? rows.slice(0, query.limit) : rows
    const last = page.at(-1)
    return {
      data: page.map(row => levelView(row, canSeeCost)),
      nextCursor:
        hasMore && last !== undefined
          ? encodeCursor({ createdAt: last.updatedAt, id: last.id })
          : null,
      hasMore
    }
  }

  // The levels of one product, one row per item and warehouse, with its totals (GET /products/:id/inventory)
  async productInventory(
    storeId: string,
    productId: string,
    canSeeCost: boolean
  ): Promise<ProductInventory> {
    const product = await this.prisma.client.product.findFirst({
      where: { id: productId, storeId },
      select: { trackInventory: true, lowStockThreshold: true }
    })
    if (product === null) throw resourceNotFound('product')
    const rows = await this.prisma.client.inventoryLevel.findMany({
      where: { storeId, productId },
      select: LEVEL_SELECT,
      orderBy: [{ warehouse: { code: 'asc' } }, { variantId: 'asc' }, { id: 'asc' }]
    })
    const onHand = rows.reduce((sum, row) => sum + row.onHand, 0)
    const reserved = rows.reduce((sum, row) => sum + row.reserved, 0)
    return {
      productId,
      trackInventory: product.trackInventory,
      lowStockThreshold: product.lowStockThreshold,
      onHand,
      reserved,
      available: onHand - reserved,
      levels: rows.map(row => levelView(row, canSeeCost))
    }
  }

  async listMovements(
    storeId: string,
    query: ListMovementsQuery,
    canSeeCost: boolean
  ): Promise<MovementPage> {
    return this.pageOfMovements(
      {
        storeId,
        ...(query.warehouseId === undefined ? {} : { warehouseId: query.warehouseId }),
        ...(query.productId === undefined ? {} : { productId: query.productId }),
        ...(query.variantId === undefined ? {} : { variantId: query.variantId }),
        ...(query.type === undefined ? {} : { type: query.type })
      },
      query,
      canSeeCost
    )
  }

  // One item in one warehouse, newest first: each row says what was on hand after it, so the balance needs no sum
  async kardex(storeId: string, query: KardexQuery, canSeeCost: boolean): Promise<MovementPage> {
    const product = await this.prisma.client.product.findFirst({
      where: { id: query.productId, storeId },
      select: { id: true }
    })
    if (product === null) throw resourceNotFound('product')
    return this.pageOfMovements(
      {
        storeId,
        productId: query.productId,
        variantId: query.variantId ?? null,
        warehouseId: query.warehouseId
      },
      query,
      canSeeCost
    )
  }

  private async pageOfMovements(
    where: Record<string, unknown>,
    query: { limit: number; cursor?: { createdAt: Date; id: string } | undefined },
    canSeeCost: boolean
  ): Promise<MovementPage> {
    const { cursor } = query
    const rows = await this.prisma.client.inventoryMovement.findMany({
      where: {
        AND: [
          where,
          cursor === undefined
            ? {}
            : {
                OR: [
                  { createdAt: { lt: cursor.createdAt } },
                  { createdAt: cursor.createdAt, id: { lt: cursor.id } }
                ]
              }
        ]
      },
      select: MOVEMENT_SELECT,
      take: query.limit + 1,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }]
    })
    const hasMore = rows.length > query.limit
    const page = hasMore ? rows.slice(0, query.limit) : rows
    const last = page.at(-1)
    return {
      data: page.map(row => movementView(row, canSeeCost)),
      nextCursor: hasMore && last !== undefined ? encodeCursor(last) : null,
      hasMore
    }
  }

  // The products whose available stock (all items, all warehouses) is at or under their threshold (TDD_16 §4.4)
  private async productsAtTheirThreshold(storeId: string): Promise<string[]> {
    const rows = await this.prisma.client.$queryRaw<{ id: string }[]>`
      SELECT p.id
      FROM products p
      JOIN inventory_levels l ON l.product_id = p.id AND l.store_id = p.store_id
      WHERE p.store_id = ${storeId} AND p.track_inventory AND p.low_stock_threshold IS NOT NULL
      GROUP BY p.id, p.low_stock_threshold
      HAVING SUM(l.on_hand - l.reserved) <= p.low_stock_threshold
      LIMIT ${LOW_STOCK_PRODUCTS_MAX}`
    return rows.map(row => row.id)
  }
}
