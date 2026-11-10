import type { Permission } from '@platform/core/auth'
import type { PrismaTransaction } from '@platform/core/database'
import { MediaStatus } from '@platform/core/domain'
import {
  ErrorCodes,
  HttpStatusCodes,
  PlatformException,
  resourceNotFound
} from '@platform/core/errors'

import { mayViewCost } from '../tenancy'

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

// Setting a cost, even to null, needs the permission to see it: whoever may not see the margin may not change it
export function assertMayWriteCost(
  held: readonly Permission[],
  body: { costCents?: number | null | undefined }
): void {
  if (body.costCents !== undefined && !mayViewCost(held)) {
    throw new PlatformException(
      ErrorCodes.PERMISSION_DENIED,
      'the cost of a product needs products:view_cost',
      HttpStatusCodes.FORBIDDEN
    )
  }
}
