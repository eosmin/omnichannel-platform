import { type AuditActionType } from '@platform/core/audit'
import type { AuditService } from '@platform/core/audit-module'
import { type Permission, Permissions } from '@platform/core/auth'
import type { PrismaTransaction } from '@platform/core/database'
import {
  formatOrderNumber,
  OrderConflicts,
  OrderNumber,
  OrderResourceTypes
} from '@platform/core/domain'
import {
  ErrorCodes,
  HttpStatusCodes,
  PlatformException,
  resourceConflict,
  resourceNotFound,
  type ErrorCode
} from '@platform/core/errors'
import type { ActorRef } from '@platform/core/events'

import type { Actor } from '../tenancy'

// The pure rules of an order answer with a code (libs/core/domain/order-rules.ts); this gives each one its HTTP status.
// A code that is not listed is a conflict with the state of the order, the usual case.
const STATUS_OF_REFUSAL: Partial<Record<ErrorCode, number>> = {
  [ErrorCodes.ORDER_PRICE_OVERRIDE_FORBIDDEN]: HttpStatusCodes.FORBIDDEN,
  [ErrorCodes.ORDER_PRICE_SELF_APPROVAL]: HttpStatusCodes.FORBIDDEN,
  [ErrorCodes.ORDER_PRICE_REASON_REQUIRED]: HttpStatusCodes.BAD_REQUEST,
  [ErrorCodes.ORDER_TOTAL_OUT_OF_RANGE]: HttpStatusCodes.BAD_REQUEST,
  [ErrorCodes.ORDER_DISCOUNT_EXCEEDS_SUBTOTAL]: HttpStatusCodes.BAD_REQUEST,
  [ErrorCodes.VALIDATION_FAILED]: HttpStatusCodes.BAD_REQUEST
}

export function orderRefusal(
  code: ErrorCode,
  metadata?: Record<string, unknown>
): PlatformException {
  return new PlatformException(
    code,
    'the order does not accept this change',
    STATUS_OF_REFUSAL[code] ?? HttpStatusCodes.CONFLICT,
    metadata
  )
}

// A caller without the permission that the body of the request asks for (the route needs a lower one)
export function permissionDenied(permission: Permission): PlatformException {
  return new PlatformException(
    ErrorCodes.PERMISSION_DENIED,
    `this needs ${permission}`,
    HttpStatusCodes.FORBIDDEN
  )
}

export function assertHolds(held: readonly Permission[], permission: Permission): void {
  if (!held.includes(permission)) throw permissionDenied(permission)
}

// What the read route protects (contact data, address, phones, reference, the notes) is for the members who may read
// orders (TDD_17 §8): a member who can only create or edit one does not read it back from the answer of a write
export const mayReadOrders = (held: readonly Permission[]): boolean =>
  held.includes(Permissions.ORDERS_VIEW)

// The order of the store, locked until the transaction ends: every change of an order takes turns, and an order of
// another store is an order that does not exist
export async function lockOrder(
  tx: PrismaTransaction,
  storeId: string,
  orderId: string
): Promise<void> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM orders WHERE id = ${orderId} AND store_id = ${storeId} FOR UPDATE`
  if (rows.length === 0) throw resourceNotFound('order')
}

// A customer absorbed by a merge is kept for 30 days with `mergedIntoId` set; an order for it belongs to the customer it
// became. Every customer on the way is held FOR SHARE until the end of the transaction, so a merge (which takes them
// FOR UPDATE) waits for the order or runs first and is seen by it. A chain is as long as the merges, and a loop cannot
// exist; the bound is only a guard against corrupt data.
const MAX_MERGE_HOPS = 10

export async function resolveCustomerForOrder(
  tx: PrismaTransaction,
  storeId: string,
  customerId: string
): Promise<string> {
  let current = customerId
  for (let hop = 0; hop <= MAX_MERGE_HOPS; hop += 1) {
    const rows = await tx.$queryRaw<{ merged_into_id: string | null; erased_at: Date | null }[]>`
      SELECT merged_into_id, erased_at FROM customers
      WHERE id = ${current} AND store_id = ${storeId} FOR SHARE`
    const row = rows[0]
    if (row === undefined) throw resourceNotFound('customer')
    if (row.merged_into_id === null) {
      // A customer that was erased has no data left to ship to: it takes no new orders
      if (row.erased_at !== null) {
        throw resourceConflict('the customer was erased', {
          conflict: OrderConflicts.CUSTOMER_ERASED
        })
      }
      return current
    }
    current = row.merged_into_id
  }
  throw new Error('a customer merge chain is longer than any merge could make')
}

// The number the next order of the store takes, raised in the same statement that reads it: two orders of one store
// take turns on the row, and a rolled-back order gives its number back (the counter is part of its transaction)
export async function takeOrderNumber(tx: PrismaTransaction, storeId: string): Promise<string> {
  const rows = await tx.$queryRaw<{ taken: number }[]>`
    UPDATE store_settings SET next_order_number = next_order_number + 1
    WHERE store_id = ${storeId}
    RETURNING next_order_number - 1 AS taken`
  const taken = rows[0]?.taken
  if (taken === undefined) throw resourceNotFound('store settings')
  if (taken > OrderNumber.MAX) {
    throw new Error('the order numbers of the store are used up')
  }
  return formatOrderNumber(taken)
}

// Who the events of an order say did it
export const actorRef = (actor: Actor): ActorRef => ({ type: 'user', id: actor.userId })

// One entry of the audit log about an order: who, from where, what changed
export function recordOrderAudit(
  audit: AuditService,
  action: AuditActionType,
  trail: { storeId: string; orderId: string; actor: Actor },
  metadata: Record<string, unknown>
): void {
  audit.log({
    action,
    actor: { userId: trail.actor.userId },
    storeId: trail.storeId,
    resourceType: OrderResourceTypes.ORDER,
    resourceId: trail.orderId,
    metadata,
    ipAddress: trail.actor.ipAddress,
    userAgent: trail.actor.userAgent
  })
}
