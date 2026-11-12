import { Injectable } from '@nestjs/common'

import type { PrismaTransaction } from '@platform/core/database'
import type { OrderStatus } from '@platform/core/domain'
import type { ActorRef } from '@platform/core/events'
import { ReturnOrderPort } from '@platform/core/shipping'

import { OrdersStatusService } from './orders-status.service'
import { lockOrder } from './orders.support'

// What a return asks of the orders (the port of `libs/core/shipping`): the order is held with the lock every writer of an order
// takes, and its status and its payment change only through the orders' own service.
@Injectable()
export class OrderReturnEffects extends ReturnOrderPort {
  constructor(private readonly status: OrdersStatusService) {
    super()
  }

  lockOrder(tx: PrismaTransaction, storeId: string, orderId: string): Promise<void> {
    return lockOrder(tx, storeId, orderId)
  }

  markReturned(
    tx: PrismaTransaction,
    storeId: string,
    orderId: string,
    actor: ActorRef
  ): Promise<{ from: OrderStatus; orderNumber: string } | null> {
    return this.status.markReturnedByReturns(tx, storeId, orderId, actor)
  }

  markRefunded(
    tx: PrismaTransaction,
    storeId: string,
    orderId: string,
    actor: ActorRef
  ): Promise<boolean> {
    return this.status.markRefundedByReturns(tx, storeId, orderId, actor)
  }
}
