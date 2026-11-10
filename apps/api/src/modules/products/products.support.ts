import type { PrismaTransaction } from '@platform/core/database'
import { MediaStatus } from '@platform/core/domain'
import { resourceNotFound } from '@platform/core/errors'

export interface LockedProduct {
  priceCents: number
  costCents: number | null
  name: string
  sku: string | null
}

// The product of the store, locked until the transaction ends: whoever changes it, or adds a variant to it,
// takes turns, and a product of another store is a product that does not exist. The caller's store comes
// from TenantGuard and is the only one this looks in.
export async function lockProduct(
  tx: PrismaTransaction,
  storeId: string,
  productId: string
): Promise<LockedProduct> {
  const rows = await tx.$queryRaw<
    { price_cents: number; cost_cents: number | null; name: string; sku: string | null }[]
  >`
    SELECT price_cents, cost_cents, name, sku FROM products WHERE id = ${productId} AND store_id = ${storeId} FOR UPDATE`
  const row = rows[0]
  if (row === undefined) throw resourceNotFound('product')
  return { priceCents: row.price_cents, costCents: row.cost_cents, name: row.name, sku: row.sku }
}

// The files of a product that count: one the scan has not judged yet or found clean. A refused or unscannable
// file is gone for every purpose of the catalog (the list of pictures, the delete guard).
export const LIVE_MEDIA_STATUSES = [MediaStatus.PENDING, MediaStatus.CLEAN]
