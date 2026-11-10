import { randomUUID } from 'node:crypto'

import type { OwnerClient } from '@platform/core/database-testing'

export interface ProductInput {
  storeId: string
  name?: string
  sku?: string
  priceCents?: number
  active?: boolean
  // Rows that are listed by age get an age of their own, so that the order never depends on the clock
  createdAt?: Date
}

// Builders write as the owner, so that a suite can put a row in any store
export async function createProduct(
  owner: OwnerClient,
  input: ProductInput
): Promise<{ id: string; name: string }> {
  return owner.product.create({
    data: {
      storeId: input.storeId,
      name: input.name ?? `product-${randomUUID().slice(0, 8)}`,
      priceCents: input.priceCents ?? 1999,
      ...(input.sku === undefined ? {} : { sku: input.sku }),
      ...(input.active === undefined ? {} : { active: input.active }),
      ...(input.createdAt === undefined ? {} : { createdAt: input.createdAt })
    },
    select: { id: true, name: true }
  })
}

export interface ProductVariantInput {
  productId: string
  name?: string
  sku?: string
  priceCents?: number | null
}

// A variant has no store of its own: it belongs to the store of its product
export async function createProductVariant(
  owner: OwnerClient,
  input: ProductVariantInput
): Promise<{ id: string; name: string }> {
  return owner.productVariant.create({
    data: {
      productId: input.productId,
      name: input.name ?? `variant-${randomUUID().slice(0, 8)}`,
      attributes: {},
      ...(input.sku === undefined ? {} : { sku: input.sku }),
      ...(input.priceCents === undefined ? {} : { priceCents: input.priceCents })
    },
    select: { id: true, name: true }
  })
}
