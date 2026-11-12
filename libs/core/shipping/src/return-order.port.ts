import type { PrismaTransaction } from '@platform/core/database'
import type { OrderStatus, ReplacementOrderBody } from '@platform/core/domain'
import type { ActorRef } from '@platform/core/events'

// The replacement order of an exchange, as the orders module made it (TDD_17 §4.11)
export interface ReplacementOrderMade {
  orderId: string
  orderNumber: string
  totalCents: number
  creditAppliedCents: number
  excessCents: number
  // The audit entries of the new order: called once the transaction has committed
  afterCommit: () => void
}

// Who asks, for the audit trail of the order that is made
export interface ReplacementActor {
  userId: string
  storeId: string
  ipAddress?: string | undefined
  userAgent?: string | undefined
}

// What a return needs of the orders (TDD_17 §4.11): the order is locked, set to RETURNED when the units that are back cover it and
// its payment is set to REFUNDED when the refunds reach the total. The orders module owns the order, so it implements this; the
// library of the shipping module, which owns the return, depends on this shape and on nothing of the api.
export abstract class ReturnOrderPort {
  // The order of the store, locked until the transaction ends; an order of another store is one that does not exist
  abstract lockOrder(tx: PrismaTransaction, storeId: string, orderId: string): Promise<void>

  // Null when the order was already returned
  abstract markReturned(
    tx: PrismaTransaction,
    storeId: string,
    orderId: string,
    actor: ActorRef
  ): Promise<{ from: OrderStatus; orderNumber: string } | null>

  // True when the payment was completed and now is refunded
  abstract markRefunded(
    tx: PrismaTransaction,
    storeId: string,
    orderId: string,
    actor: ActorRef
  ): Promise<boolean>

  // The replacement of an exchange, already CONFIRMED for the customer of `ofOrderId`, in the transaction of the return: its
  // discount is the credit (exempt from the limit and from the approval), its stock is reserved like any order's
  abstract createReplacement(
    tx: PrismaTransaction,
    storeId: string,
    input: {
      ofOrderId: string
      returnId: string
      creditCents: number
      replacement: ReplacementOrderBody
    },
    actor: ReplacementActor
  ): Promise<ReplacementOrderMade>
}
