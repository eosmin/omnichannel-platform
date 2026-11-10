import { Injectable } from '@nestjs/common'

import { AuditAction } from '@platform/core/audit'
import { AuditService } from '@platform/core/audit-module'
import { isUniqueViolation, lockStoreForWrite, PrismaService } from '@platform/core/database'
import {
  MediaStatus,
  ProductConflicts,
  ProductHistoryTables,
  ProductResourceTypes
} from '@platform/core/domain'
import { resourceConflict, resourceNotFound } from '@platform/core/errors'
import { DomainEvents } from '@platform/core/event-bus'
import { Events } from '@platform/core/events'

import { encodeCursor } from '../customers/list-cursor'
import type { Actor } from '../tenancy'

import type { CreateProductBody, ListProductsQuery, UpdateProductBody } from './products.schemas'
import { lockProduct } from './products.support'
import {
  PRODUCT_SELECT,
  type ProductDetail,
  type ProductPage,
  VARIANT_SELECT,
  variantView
} from './products.views'

const skuInUse = () =>
  resourceConflict('the sku is already used by another product of the store', {
    conflict: ProductConflicts.SKU_IN_USE
  })

// The products of the store of the request. Every query is filtered by that store (TenantGuard), and the
// store is never read from the body or the query string. The variants have their own service.
@Injectable()
export class ProductsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly events: DomainEvents
  ) {}

  async list(storeId: string, query: ListProductsQuery): Promise<ProductPage> {
    const { cursor } = query
    const rows = await this.prisma.client.product.findMany({
      where: {
        storeId,
        ...(query.active === undefined ? {} : { active: query.active }),
        // After the last row of the previous page in (createdAt, id) order, wherever that row is now
        ...(cursor === undefined
          ? {}
          : {
              OR: [
                { createdAt: { lt: cursor.createdAt } },
                { createdAt: cursor.createdAt, id: { lt: cursor.id } }
              ]
            })
      },
      select: { ...PRODUCT_SELECT, _count: { select: { variants: true } } },
      take: query.limit + 1,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }]
    })
    const hasMore = rows.length > query.limit
    const page = hasMore ? rows.slice(0, query.limit) : rows
    const last = page.at(-1)
    return {
      data: page.map(({ _count, ...product }) => ({ ...product, variantCount: _count.variants })),
      nextCursor: hasMore && last !== undefined ? encodeCursor(last) : null,
      hasMore
    }
  }

  async get(storeId: string, productId: string): Promise<ProductDetail> {
    const product = await this.prisma.client.product.findFirst({
      where: { id: productId, storeId },
      select: {
        ...PRODUCT_SELECT,
        variants: { select: VARIANT_SELECT, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }
      }
    })
    if (product === null) throw resourceNotFound('product')
    return {
      ...product,
      variants: product.variants.map(variant => variantView(variant, product))
    }
  }

  async create(storeId: string, body: CreateProductBody): Promise<ProductDetail> {
    const id = await this.write(() =>
      this.prisma.transaction(async tx => {
        await lockStoreForWrite(tx, storeId)
        const created = await tx.product.create({
          data: {
            storeId,
            name: body.name,
            priceCents: body.priceCents,
            ...(body.description === undefined ? {} : { description: body.description }),
            ...(body.costCents === undefined ? {} : { costCents: body.costCents }),
            ...(body.sku === undefined ? {} : { sku: body.sku }),
            ...(body.trackInventory === undefined ? {} : { trackInventory: body.trackInventory }),
            ...(body.lowStockThreshold === undefined
              ? {}
              : { lowStockThreshold: body.lowStockThreshold }),
            ...(body.active === undefined ? {} : { active: body.active }),
            ...(body.freeShipping === undefined ? {} : { freeShipping: body.freeShipping })
          },
          select: { id: true }
        })
        this.events.publish(tx, Events.PRODUCT_CREATED, { storeId, productId: created.id })
        return created.id
      })
    )
    return this.get(storeId, id)
  }

  async update(
    storeId: string,
    productId: string,
    body: UpdateProductBody,
    actor: Actor
  ): Promise<ProductDetail> {
    const previous = await this.write(() =>
      this.prisma.transaction(async tx => {
        const before = await lockProduct(tx, storeId, productId)
        await tx.product.update({
          where: { id: productId },
          data: {
            ...(body.name === undefined ? {} : { name: body.name }),
            ...(body.description === undefined ? {} : { description: body.description }),
            ...(body.priceCents === undefined ? {} : { priceCents: body.priceCents }),
            ...(body.costCents === undefined ? {} : { costCents: body.costCents }),
            ...(body.sku === undefined ? {} : { sku: body.sku }),
            ...(body.trackInventory === undefined ? {} : { trackInventory: body.trackInventory }),
            ...(body.lowStockThreshold === undefined
              ? {}
              : { lowStockThreshold: body.lowStockThreshold }),
            ...(body.active === undefined ? {} : { active: body.active }),
            ...(body.freeShipping === undefined ? {} : { freeShipping: body.freeShipping })
          }
        })
        this.events.publish(tx, Events.PRODUCT_UPDATED, { storeId, productId })
        return before
      })
    )
    if (body.costCents !== undefined && body.costCents !== previous.costCents) {
      this.audit.log({
        action: AuditAction.PRODUCT_COST_CHANGED,
        actor: { userId: actor.userId },
        storeId,
        resourceType: ProductResourceTypes.PRODUCT,
        resourceId: productId,
        metadata: { fromCents: previous.costCents, toCents: body.costCents },
        ipAddress: actor.ipAddress,
        userAgent: actor.userAgent
      })
    }
    if (body.priceCents !== undefined && body.priceCents !== previous.priceCents) {
      this.audit.log({
        action: AuditAction.PRODUCT_PRICE_CHANGED,
        actor: { userId: actor.userId },
        storeId,
        resourceType: ProductResourceTypes.PRODUCT,
        resourceId: productId,
        metadata: { fromCents: previous.priceCents, toCents: body.priceCents },
        ipAddress: actor.ipAddress,
        userAgent: actor.userAgent
      })
    }
    return this.get(storeId, productId)
  }

  // A product that an order, a stock movement or a file names is part of the history of the store and is not
  // deleted (409): the client archives it with PATCH `active: false`, as a customer with orders stays. Deleting
  // a product with files would orphan them (`Media.productId` is SET NULL), so they keep it from being deleted.
  async remove(storeId: string, productId: string, actor: Actor): Promise<void> {
    const removed = await this.prisma.transaction(async tx => {
      const product = await lockProduct(tx, storeId, productId)
      const [orderItems, inventoryMovements, media] = await Promise.all([
        tx.orderItem.count({ where: { productId } }),
        tx.inventoryMovement.count({ where: { storeId, productId } }),
        // A file the scan refused or could not clear is never served and nobody can remove it: it does not keep the product
        tx.media.count({
          where: { storeId, productId, status: { in: [MediaStatus.PENDING, MediaStatus.CLEAN] } }
        })
      ])
      if (orderItems > 0 || inventoryMovements > 0 || media > 0) {
        throw resourceConflict(
          'a product with orders, stock movements or files cannot be deleted',
          {
            conflict: ProductConflicts.HAS_HISTORY,
            [ProductHistoryTables.ORDER_ITEMS]: orderItems,
            [ProductHistoryTables.INVENTORY_MOVEMENTS]: inventoryMovements,
            [ProductHistoryTables.MEDIA]: media
          }
        )
      }
      await tx.product.delete({ where: { id: productId } })
      this.events.publish(tx, Events.PRODUCT_DELETED, { storeId, productId })
      return product
    })
    this.audit.log({
      action: AuditAction.PRODUCT_DELETED,
      actor: { userId: actor.userId },
      storeId,
      resourceType: ProductResourceTypes.PRODUCT,
      resourceId: productId,
      // The row is gone: the entry is what says what it was
      metadata: {
        name: removed.name,
        sku: removed.sku,
        priceCents: removed.priceCents,
        costCents: removed.costCents
      },
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent
    })
  }

  // The unique index of (store, sku) has the last word when two writers bring the same sku at once
  private async write<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run()
    } catch (error) {
      if (isUniqueViolation(error)) throw skuInUse()
      throw error
    }
  }
}
