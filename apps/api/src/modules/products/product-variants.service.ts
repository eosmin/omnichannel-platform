import { Injectable } from '@nestjs/common'

import { AuditAction } from '@platform/core/audit'
import { AuditService } from '@platform/core/audit-module'
import { lockStoreScope, type PrismaTransaction, PrismaService } from '@platform/core/database'
import {
  ProductConflicts,
  ProductHistoryTables,
  ProductLimits,
  ProductLockScopes,
  ProductResourceTypes
} from '@platform/core/domain'
import { resourceConflict, resourceNotFound } from '@platform/core/errors'
import { DomainEvents } from '@platform/core/event-bus'
import { Events } from '@platform/core/events'

import type { Actor } from '../tenancy'

import type { CreateVariantBody, UpdateVariantBody } from './products.schemas'
import { lockProduct } from './products.support'
import { VARIANT_SELECT, type VariantView, variantView } from './products.views'

const nameInUse = () =>
  resourceConflict('the product already has a variant with that name', {
    conflict: ProductConflicts.VARIANT_NAME_IN_USE
  })
const skuInUse = () =>
  resourceConflict('the sku is already used by another variant of the store', {
    conflict: ProductConflicts.SKU_IN_USE
  })

// The variants of a product of the store of the request. A variant has no store of its own: it is reached
// through its product, and the product is looked up in the store of TenantGuard first, so the variant of a
// product of another store is a variant that does not exist.
@Injectable()
export class ProductVariantsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly events: DomainEvents
  ) {}

  async create(storeId: string, productId: string, body: CreateVariantBody): Promise<VariantView> {
    return this.prisma.transaction(async tx => {
      const product = await lockProduct(tx, storeId, productId)
      const [count, sameName] = await Promise.all([
        tx.productVariant.count({ where: { productId } }),
        tx.productVariant.count({ where: { productId, name: body.name } })
      ])
      if (count >= ProductLimits.MAX_VARIANTS_PER_PRODUCT) {
        throw resourceConflict('the product has the most variants it may have', {
          conflict: ProductConflicts.TOO_MANY_VARIANTS,
          max: ProductLimits.MAX_VARIANTS_PER_PRODUCT
        })
      }
      if (sameName > 0) throw nameInUse()
      if (body.sku !== undefined) await this.assertSkuFree(tx, storeId, body.sku, null)
      const created = await tx.productVariant.create({
        data: {
          productId,
          name: body.name,
          attributes: body.attributes ?? {},
          ...(body.sku === undefined ? {} : { sku: body.sku }),
          ...(body.priceCents === undefined ? {} : { priceCents: body.priceCents }),
          ...(body.costCents === undefined ? {} : { costCents: body.costCents }),
          ...(body.active === undefined ? {} : { active: body.active })
        },
        select: VARIANT_SELECT
      })
      this.events.publish(tx, Events.PRODUCT_UPDATED, { storeId, productId })
      return variantView(created, product)
    })
  }

  async update(
    storeId: string,
    productId: string,
    variantId: string,
    body: UpdateVariantBody,
    actor: Actor
  ): Promise<VariantView> {
    const { view, previous } = await this.prisma.transaction(async tx => {
      const product = await lockProduct(tx, storeId, productId)
      const current = await tx.productVariant.findFirst({
        where: { id: variantId, productId },
        select: { priceCents: true, costCents: true }
      })
      if (current === null) throw resourceNotFound('variant')
      if (body.name !== undefined) {
        const sameName = await tx.productVariant.count({
          where: { productId, name: body.name, id: { not: variantId } }
        })
        if (sameName > 0) throw nameInUse()
      }
      if (body.sku !== undefined && body.sku !== null) {
        await this.assertSkuFree(tx, storeId, body.sku, variantId)
      }
      const updated = await tx.productVariant.update({
        where: { id: variantId },
        data: {
          ...(body.name === undefined ? {} : { name: body.name }),
          ...(body.sku === undefined ? {} : { sku: body.sku }),
          ...(body.priceCents === undefined ? {} : { priceCents: body.priceCents }),
          ...(body.costCents === undefined ? {} : { costCents: body.costCents }),
          ...(body.attributes === undefined ? {} : { attributes: body.attributes }),
          ...(body.active === undefined ? {} : { active: body.active })
        },
        select: VARIANT_SELECT
      })
      this.events.publish(tx, Events.PRODUCT_UPDATED, { storeId, productId })
      return { view: variantView(updated, product), previous: current }
    })
    if (body.costCents !== undefined && body.costCents !== previous.costCents) {
      this.audit.log({
        action: AuditAction.PRODUCT_COST_CHANGED,
        actor: { userId: actor.userId },
        storeId,
        resourceType: ProductResourceTypes.VARIANT,
        resourceId: variantId,
        metadata: { productId, fromCents: previous.costCents, toCents: body.costCents },
        ipAddress: actor.ipAddress,
        userAgent: actor.userAgent
      })
    }
    if (body.priceCents !== undefined && body.priceCents !== previous.priceCents) {
      this.audit.log({
        action: AuditAction.PRODUCT_PRICE_CHANGED,
        actor: { userId: actor.userId },
        storeId,
        resourceType: ProductResourceTypes.VARIANT,
        resourceId: variantId,
        metadata: { productId, fromCents: previous.priceCents, toCents: body.priceCents },
        ipAddress: actor.ipAddress,
        userAgent: actor.userAgent
      })
    }
    return view
  }

  // Like a product, a variant that an order or a stock movement names is not deleted (409): it is archived
  async remove(storeId: string, productId: string, variantId: string, actor: Actor): Promise<void> {
    const removed = await this.prisma.transaction(async tx => {
      await lockProduct(tx, storeId, productId)
      const variant = await tx.productVariant.findFirst({
        where: { id: variantId, productId },
        select: { id: true, name: true, sku: true }
      })
      if (variant === null) throw resourceNotFound('variant')
      const [orderItems, inventoryMovements, inventoryLevels, transferLines] = await Promise.all([
        tx.orderItem.count({ where: { variantId } }),
        tx.inventoryMovement.count({ where: { storeId, variantId } }),
        tx.inventoryLevel.count({ where: { storeId, variantId } }),
        tx.stockTransferLine.count({ where: { storeId, variantId } })
      ])
      if (orderItems > 0 || inventoryMovements > 0 || inventoryLevels > 0 || transferLines > 0) {
        throw resourceConflict('a variant with orders, stock or transfers cannot be deleted', {
          conflict: ProductConflicts.HAS_HISTORY,
          [ProductHistoryTables.ORDER_ITEMS]: orderItems,
          [ProductHistoryTables.INVENTORY_MOVEMENTS]: inventoryMovements,
          [ProductHistoryTables.INVENTORY_LEVELS]: inventoryLevels,
          [ProductHistoryTables.TRANSFER_LINES]: transferLines
        })
      }
      await tx.productVariant.delete({ where: { id: variantId } })
      this.events.publish(tx, Events.PRODUCT_UPDATED, { storeId, productId })
      return variant
    })
    this.audit.log({
      action: AuditAction.PRODUCT_VARIANT_DELETED,
      actor: { userId: actor.userId },
      storeId,
      resourceType: ProductResourceTypes.VARIANT,
      resourceId: variantId,
      metadata: { productId, name: removed.name, sku: removed.sku },
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent
    })
  }

  // The sku of a variant is unique in its whole store, which no index can say (a variant has no store): the
  // writers of a sku take turns on a lock of the store, and the check runs inside it
  private async assertSkuFree(
    tx: PrismaTransaction,
    storeId: string,
    sku: string,
    exceptVariantId: string | null
  ): Promise<void> {
    await lockStoreScope(tx, storeId, ProductLockScopes.VARIANT_SKU)
    const taken = await tx.productVariant.count({
      where: {
        sku,
        product: { storeId },
        ...(exceptVariantId === null ? {} : { id: { not: exceptVariantId } })
      }
    })
    if (taken > 0) throw skuInUse()
  }
}
