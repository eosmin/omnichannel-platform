import { Injectable } from '@nestjs/common'

import { PrismaService } from '@platform/core/database'
import { InventoryLevelSorts } from '@platform/core/domain'
import { resourceNotFound } from '@platform/core/errors'
import { escapeLike } from '@platform/core/messaging'

import { encodeCursor } from '../customers/list-cursor'

import {
  encodeNameCursor,
  encodeSeqCursor,
  type KardexQuery,
  type ListLevelsQuery,
  type ListMovementsQuery
} from './inventory.schemas'
import {
  LEVEL_SELECT,
  type LevelPage,
  levelView,
  MOVEMENT_SELECT,
  type MovementPage,
  movementView,
  type ProductInventory,
  type StockSummary
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
    // Read as the characters it is: the wildcards of LIKE are escaped
    const text = query.q === undefined ? undefined : escapeLike(query.q)
    const byName = query.sort === InventoryLevelSorts.NAME
    const lowStockProducts =
      query.lowStock === true ? await this.productsAtTheirThreshold(storeId) : null
    const rows = await this.prisma.client.inventoryLevel.findMany({
      where: {
        storeId,
        ...(query.warehouseId === undefined ? {} : { warehouseId: query.warehouseId }),
        ...(query.productId === undefined ? {} : { productId: query.productId }),
        ...(query.variantId === undefined ? {} : { variantId: query.variantId }),
        AND: [
          // Both filters together are an intersection, not one over the other
          ...(lowStockProducts === null
            ? []
            : [
                {
                  productId: {
                    in:
                      query.productId === undefined
                        ? lowStockProducts
                        : lowStockProducts.filter(id => id === query.productId)
                  }
                }
              ]),
          // The text is the name or SKU of the product, or of the variant of the level, read as the characters it is: the
          // wildcards of LIKE are escaped (Prisma's `contains` does not do it)
          ...(text === undefined
            ? []
            : [
                {
                  OR: [
                    {
                      product: {
                        name: { contains: text, mode: 'insensitive' as const }
                      }
                    },
                    {
                      product: {
                        sku: { contains: text, mode: 'insensitive' as const }
                      }
                    },
                    {
                      variant: {
                        name: { contains: text, mode: 'insensitive' as const }
                      }
                    },
                    {
                      variant: {
                        sku: { contains: text, mode: 'insensitive' as const }
                      }
                    }
                  ]
                }
              ]),
          // After the last row of the previous page, wherever that row is now
          ...(cursor === undefined
            ? []
            : cursor.sort === InventoryLevelSorts.NAME
              ? [
                  {
                    OR: [
                      { product: { name: { gt: cursor.position.name } } },
                      { product: { name: cursor.position.name }, id: { gt: cursor.position.id } }
                    ]
                  }
                ]
              : [
                  {
                    OR: [
                      { updatedAt: { lt: cursor.position.createdAt } },
                      { updatedAt: cursor.position.createdAt, id: { lt: cursor.position.id } }
                    ]
                  }
                ])
        ]
      },
      select: LEVEL_SELECT,
      take: query.limit + 1,
      orderBy: byName
        ? [{ product: { name: 'asc' } }, { id: 'asc' }]
        : [{ updatedAt: 'desc' }, { id: 'desc' }]
    })
    const hasMore = rows.length > query.limit
    const page = hasMore ? rows.slice(0, query.limit) : rows
    const last = page.at(-1)
    return {
      data: page.map(row => levelView(row, canSeeCost)),
      nextCursor:
        hasMore && last !== undefined
          ? byName
            ? encodeNameCursor({ name: last.product.name, id: last.id })
            : encodeCursor({ createdAt: last.updatedAt, id: last.id })
          : null,
      hasMore
    }
  }

  // The available stock of the products asked for, one row each: a product of another store (or one that does not
  // exist) is simply not in the answer. A product with no level has nothing on hand.
  async summary(storeId: string, productIds: string[]): Promise<StockSummary> {
    const [products, sums] = await Promise.all([
      this.prisma.client.product.findMany({
        where: { storeId, id: { in: productIds } },
        select: { id: true, trackInventory: true, lowStockThreshold: true }
      }),
      this.prisma.client.inventoryLevel.groupBy({
        by: ['productId'],
        where: { storeId, productId: { in: productIds } },
        _sum: { onHand: true, reserved: true }
      })
    ])
    const sumOf = new Map(sums.map(row => [row.productId, row._sum]))
    return {
      data: products.map(product => {
        const sum = sumOf.get(product.id)
        const onHand = sum?.onHand ?? 0
        const reserved = sum?.reserved ?? 0
        const available = onHand - reserved
        return {
          productId: product.id,
          trackInventory: product.trackInventory,
          onHand,
          reserved,
          available,
          lowStockThreshold: product.lowStockThreshold,
          isLow:
            product.trackInventory &&
            product.lowStockThreshold !== null &&
            available <= product.lowStockThreshold
        }
      })
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
    query: { limit: number; cursor?: bigint | undefined },
    canSeeCost: boolean
  ): Promise<MovementPage> {
    const rows = await this.prisma.client.inventoryMovement.findMany({
      where: { ...where, ...(query.cursor === undefined ? {} : { seq: { lt: query.cursor } }) },
      select: MOVEMENT_SELECT,
      take: query.limit + 1,
      // The order the ledger was written in (see InventoryMovement.seq): the movements of one transaction share a created_at
      orderBy: { seq: 'desc' }
    })
    const hasMore = rows.length > query.limit
    const page = hasMore ? rows.slice(0, query.limit) : rows
    const last = page.at(-1)
    return {
      data: page.map(row => movementView(row, canSeeCost)),
      nextCursor: hasMore && last !== undefined ? encodeSeqCursor(last.seq) : null,
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
      ORDER BY p.id
      LIMIT ${LOW_STOCK_PRODUCTS_MAX}`
    return rows.map(row => row.id)
  }
}
