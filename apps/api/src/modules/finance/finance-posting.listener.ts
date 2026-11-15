import { Injectable } from '@nestjs/common'
import { OnEvent } from '@nestjs/event-emitter'
import { PinoLogger } from 'nestjs-pino'

import { PrismaService } from '@platform/core/database'
import {
  FinanceEventKind,
  FinanceSourceType,
  OrderStatus,
  PaymentStatus
} from '@platform/core/domain'
import { errorName } from '@platform/core/errors'
import {
  Events,
  type InventoryMovedPayload,
  type OrderPaymentPayload,
  type OrderStatusChangedPayload
} from '@platform/core/events'
import { isAdjustmentType } from '@platform/core/finance'
import { FinancePostingService } from '@platform/core/finance-ledger'
import type { PostFinanceEventJob } from '@platform/core/queues'

import { FinancePostingQueue } from './finance-posting.queue'

// The business events become the automatic entries of the books (TDD_18 §6.1): each one is queued as a job that names the source and
// the event, and the worker loads the rows as they are and posts under the key of the event. Nothing here posts, and a failure to
// queue never reaches the operation that raised the event: the sale, the shipment and the count stand, and the entry is the
// books' business (the sweep of Step 4B.6b finds what was never queued).
@Injectable()
export class FinancePostingListener {
  constructor(
    private readonly prisma: PrismaService,
    private readonly logger: PinoLogger,
    private readonly queue: FinancePostingQueue,
    private readonly posting: FinancePostingService
  ) {
    this.logger.setContext(FinancePostingListener.name)
  }

  // E1: an order is paid
  @OnEvent(Events.ORDER_PAYMENT_STATUS_CHANGED)
  async onPayment(payload: OrderPaymentPayload): Promise<void> {
    if (payload.to !== PaymentStatus.COMPLETED) return
    // SALE too: an order delivered before it was paid waits for this, and an order not yet delivered posts nothing
    await this.enqueueOrder(payload.storeId, payload.orderId, [
      FinanceEventKind.PAYMENT,
      FinanceEventKind.SALE
    ])
  }

  // E2 and E3: the goods left, the order was delivered. Shipping asks for both: the service decides which of the two the setting of the
  // organization wants at that moment, and an event that has not come yet posts nothing
  @OnEvent(Events.ORDER_STATUS_CHANGED)
  async onOrderStatus(payload: OrderStatusChangedPayload): Promise<void> {
    if (payload.to !== OrderStatus.SHIPPED && payload.to !== OrderStatus.DELIVERED) return
    // Delivery asks for SENT again in case the shipping event was missed: the key makes it one entry
    await this.enqueueOrder(payload.storeId, payload.orderId, [
      FinanceEventKind.SENT,
      FinanceEventKind.SALE
    ])
  }

  // E9: a stock adjustment or a count variance
  @OnEvent(Events.INVENTORY_MOVED)
  async onMovement(payload: InventoryMovedPayload): Promise<void> {
    if (!isAdjustmentType(payload.type)) return
    const organizationId = await this.organizationOf(payload.storeId)
    if (organizationId === null) return
    await this.enqueue({
      organizationId,
      sourceType: FinanceSourceType.INVENTORY_MOVEMENT,
      sourceId: payload.movementId,
      kind: FinanceEventKind.ADJUST
    })
  }

  private async enqueueOrder(
    storeId: string,
    orderId: string,
    kinds: readonly FinanceEventKind[]
  ): Promise<void> {
    const organizationId = await this.organizationOf(storeId)
    if (organizationId === null) return
    const occurredAt = new Date().toISOString()
    for (const kind of kinds) {
      await this.enqueue({
        organizationId,
        sourceType: FinanceSourceType.ORDER,
        sourceId: orderId,
        kind,
        occurredAt
      })
    }
  }

  private async organizationOf(storeId: string): Promise<string | null> {
    try {
      const store = await this.prisma.client.store.findUnique({
        where: { id: storeId },
        select: { organizationId: true }
      })
      return store?.organizationId ?? null
    } catch (error) {
      this.logger.error(
        { storeId, errorName: errorName(error) },
        'the organization of a store could not be read'
      )
      return null
    }
  }

  private async enqueue(job: PostFinanceEventJob): Promise<void> {
    try {
      await this.queue.enqueue(job)
    } catch (error) {
      this.logger.error(
        {
          sourceType: job.sourceType,
          sourceId: job.sourceId,
          kind: job.kind,
          errorName: errorName(error)
        },
        'an automatic entry could not be queued'
      )
      // Not lost in silence: the source is on the list of failures, where a person presses "post again" and the sweep of 4B.6b looks
      await this.markNotQueued(job)
    }
  }

  private async markNotQueued(job: PostFinanceEventJob): Promise<void> {
    try {
      await this.posting.markUnposted(job)
    } catch (error) {
      this.logger.error(
        { errorName: errorName(error) },
        'a source that was not queued could not be listed'
      )
    }
  }
}
