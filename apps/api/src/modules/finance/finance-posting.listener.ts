import { Injectable } from '@nestjs/common'
import { OnEvent } from '@nestjs/event-emitter'
import { PinoLogger } from 'nestjs-pino'

import { PrismaService } from '@platform/core/database'
import {
  FinanceEventKind,
  FinanceSourceType,
  OrderStatus,
  PaymentStatus,
  ShipmentStatus
} from '@platform/core/domain'
import { errorName } from '@platform/core/errors'
import {
  Events,
  type InventoryMovedPayload,
  type OrderPaymentPayload,
  type OrderStatusChangedPayload,
  type RemittanceDifferenceWrittenOffPayload,
  type RemittanceEventPayload,
  type ReturnEventPayload,
  type ShipmentStatusChangedPayload
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

  // E8: a return was received (its units are back, and the books give back their share of the sale)
  @OnEvent(Events.RETURN_RECEIVED)
  async onReturnReceived(payload: ReturnEventPayload): Promise<void> {
    const organizationId = await this.organizationOf(payload.storeId)
    if (organizationId === null) return
    await this.enqueue({
      organizationId,
      sourceType: FinanceSourceType.RETURN,
      sourceId: payload.returnId,
      kind: FinanceEventKind.RETURN_RESTOCK,
      occurredAt: new Date().toISOString()
    })
  }

  // E14: a person recorded the refund they paid out when completing a return
  @OnEvent(Events.RETURN_REFUND_RECORDED)
  async onReturnRefund(payload: ReturnEventPayload): Promise<void> {
    const organizationId = await this.organizationOf(payload.storeId)
    if (organizationId === null) return
    await this.enqueue({
      organizationId,
      sourceType: FinanceSourceType.RETURN,
      sourceId: payload.returnId,
      kind: FinanceEventKind.RETURN_REFUND,
      occurredAt: new Date().toISOString()
    })
  }

  // E2 and E3: the goods left, the order was delivered. Shipping asks for both: the service decides which of the two the setting of the
  // organization wants at that moment, and an event that has not come yet posts nothing. E8: an order put back as a whole (a parcel that
  // came back, or an order an agent returned with no return row) asks for its own entry; an order whose returns were received has none,
  // each return posts its part
  @OnEvent(Events.ORDER_STATUS_CHANGED)
  async onOrderStatus(payload: OrderStatusChangedPayload): Promise<void> {
    if (payload.to === OrderStatus.RETURNED) {
      await this.enqueueOrder(payload.storeId, payload.orderId, [FinanceEventKind.ORDER_RETURN])
      return
    }
    if (payload.to !== OrderStatus.SHIPPED && payload.to !== OrderStatus.DELIVERED) return
    // Delivery asks for SENT again in case the shipping event was missed: the key makes it one entry
    await this.enqueueOrder(payload.storeId, payload.orderId, [
      FinanceEventKind.SENT,
      FinanceEventKind.SALE
    ])
  }

  // E4: a guide was delivered, so the carrier's charges for it are owed (the guide of the way out and the guide of a return)
  @OnEvent(Events.SHIPMENT_STATUS_CHANGED)
  async onShipmentStatus(payload: ShipmentStatusChangedPayload): Promise<void> {
    if (payload.to !== ShipmentStatus.DELIVERED) return
    const organizationId = await this.organizationOf(payload.storeId)
    if (organizationId === null) return
    await this.enqueue({
      organizationId,
      sourceType: FinanceSourceType.SHIPMENT,
      sourceId: payload.shipmentId,
      kind: FinanceEventKind.CHARGES,
      occurredAt: new Date().toISOString()
    })
  }

  // E5 and E6: a remittance was confirmed, or a confirmed one was voided
  @OnEvent(Events.REMITTANCE_CONFIRMED)
  async onRemittanceConfirmed(payload: RemittanceEventPayload): Promise<void> {
    await this.enqueueRemittance(payload, FinanceEventKind.REMITTANCE_CONFIRM)
  }

  @OnEvent(Events.REMITTANCE_VOIDED)
  async onRemittanceVoided(payload: RemittanceEventPayload): Promise<void> {
    await this.enqueueRemittance(payload, FinanceEventKind.REMITTANCE_VOID)
  }

  // E7: a person wrote off the difference of a guide
  @OnEvent(Events.REMITTANCE_DIFFERENCE_WRITTEN_OFF)
  async onDifferenceWrittenOff(payload: RemittanceDifferenceWrittenOffPayload): Promise<void> {
    const organizationId = await this.organizationOf(payload.storeId)
    if (organizationId === null) return
    await this.enqueue({
      organizationId,
      sourceType: FinanceSourceType.SHIPMENT,
      sourceId: payload.shipmentId,
      kind: FinanceEventKind.COD_WRITE_OFF,
      occurredAt: new Date().toISOString()
    })
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

  private async enqueueRemittance(
    payload: RemittanceEventPayload,
    kind: FinanceEventKind
  ): Promise<void> {
    const organizationId = await this.organizationOf(payload.storeId)
    if (organizationId === null) return
    await this.enqueue({
      organizationId,
      sourceType: FinanceSourceType.REMITTANCE,
      sourceId: payload.remittanceId,
      kind,
      occurredAt: new Date().toISOString()
    })
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
