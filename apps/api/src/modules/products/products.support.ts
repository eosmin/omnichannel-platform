import type { AuditAction } from '@platform/core/audit'
import type { AuditService } from '@platform/core/audit-module'
import { type Permission, Permissions } from '@platform/core/auth'
import type { PrismaTransaction } from '@platform/core/database'
import {
  MediaStatus,
  ProductConflicts,
  ProductResourceTypes,
  TaxTreatment
} from '@platform/core/domain'
import {
  ErrorCodes,
  HttpStatusCodes,
  PlatformException,
  resourceConflict,
  resourceNotFound
} from '@platform/core/errors'

import { type Actor, auditActorOf, auditViaOf, mayViewCost } from '../tenancy'

export interface LockedProduct {
  priceCents: number
  costCents: number | null
  name: string
  sku: string | null
  taxTreatment: string
  taxRateId: string | null
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
    {
      price_cents: number
      cost_cents: number | null
      name: string
      sku: string | null
      tax_treatment: string
      tax_rate_id: string | null
    }[]
  >`
    SELECT price_cents, cost_cents, name, sku, tax_treatment, tax_rate_id FROM products WHERE id = ${productId} AND store_id = ${storeId} FOR UPDATE`
  const row = rows[0]
  if (row === undefined) throw resourceNotFound('product')
  return {
    priceCents: row.price_cents,
    costCents: row.cost_cents,
    name: row.name,
    sku: row.sku,
    taxTreatment: row.tax_treatment,
    taxRateId: row.tax_rate_id
  }
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

// How a product is taxed decides what an order charges and what the books owe, so changing it, even to the value it has, needs the
// permission that manages the taxes: whoever edits a product may not make it exempt
export function assertMayWriteTax(
  held: readonly Permission[],
  body: { taxTreatment?: unknown; taxRateId?: unknown }
): void {
  if (
    (body.taxTreatment !== undefined || body.taxRateId !== undefined) &&
    !held.includes(Permissions.FINANCE_MANAGE_ACCOUNTS)
  ) {
    throw new PlatformException(
      ErrorCodes.PERMISSION_DENIED,
      'the tax of a product needs finance:manage_accounts',
      HttpStatusCodes.FORBIDDEN
    )
  }
}

// The tax columns a product ends up with: the request over what the product has. A product that is not taxed names no rate, and a
// rate is one of the organization of the store (another organization's is one that does not exist) and is on. The row of the rate
// is locked in share mode, so a rate cannot be switched off between this check and the write that names it.
export async function resolveProductTax(
  tx: PrismaTransaction,
  storeId: string,
  current: { taxTreatment: string; taxRateId: string | null },
  body: { taxTreatment?: TaxTreatment | undefined; taxRateId?: string | null | undefined }
): Promise<{ taxTreatment: TaxTreatment; taxRateId: string | null }> {
  const taxTreatment = body.taxTreatment ?? (current.taxTreatment as TaxTreatment)
  let taxRateId = body.taxRateId === undefined ? current.taxRateId : body.taxRateId
  if (taxTreatment !== TaxTreatment.TAXED) {
    // A rate the request names for a product that is not taxed is a contradiction; one it kept is dropped with the treatment
    if (typeof body.taxRateId === 'string') {
      throw new PlatformException(
        ErrorCodes.VALIDATION_INVALID_INPUT,
        'only a taxed product has a tax rate of its own',
        HttpStatusCodes.BAD_REQUEST
      )
    }
    taxRateId = null
  }
  if (taxRateId !== null) {
    const rows = await tx.$queryRaw<{ active: boolean }[]>`
      SELECT r.active FROM tax_rates r
      JOIN stores s ON s.organization_id = r.organization_id
      WHERE r.id = ${taxRateId} AND s.id = ${storeId} FOR SHARE OF r`
    const rate = rows[0]
    if (rate === undefined) throw resourceNotFound('tax rate')
    // Keeping a rate that was switched off since is not naming it again
    if (!rate.active && taxRateId !== current.taxRateId) {
      throw resourceConflict('the tax rate is switched off', {
        conflict: ProductConflicts.TAX_RATE_INACTIVE
      })
    }
  }
  return { taxTreatment, taxRateId }
}

// The general entry of a write to the catalog (a product made, a product or a variant changed): who, and which fields the request SET (not whether the value differed from the stored one). The fields
// are named and their values are not, as a name or a description is free text; the price, cost and tax have their own entries
// with the values. A plugin is the system with its installation in the metadata (`auditActorOf`, `auditViaOf`).
export function auditProductWrite(
  audit: AuditService,
  storeId: string,
  actor: Actor,
  entry: {
    action: typeof AuditAction.PRODUCT_CREATED | typeof AuditAction.PRODUCT_UPDATED
    productId: string
    variantId?: string
    fields: readonly string[]
  }
): void {
  audit.log({
    action: entry.action,
    actor: auditActorOf(actor),
    storeId,
    resourceType: ProductResourceTypes.PRODUCT,
    resourceId: entry.productId,
    metadata: {
      ...(entry.variantId === undefined ? {} : { variantId: entry.variantId }),
      fields: [...entry.fields],
      ...auditViaOf(actor)
    },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent
  })
}

// The names of the fields a body sets (a field left out is not a change)
export function fieldsSet(body: object): string[] {
  return Object.entries(body)
    .filter(([, value]) => value !== undefined)
    .map(([key]) => key)
    .sort()
}
