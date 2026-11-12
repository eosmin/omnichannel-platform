import type { PrismaTransaction } from '@platform/core/database'
import type { OrderStatus } from '@platform/core/domain'
import type { ActorRef } from '@platform/core/events'

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
}
