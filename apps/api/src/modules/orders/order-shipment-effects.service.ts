import { Injectable } from '@nestjs/common'
import { PinoLogger } from 'nestjs-pino'

import { AuditAction } from '@platform/core/audit'
import { AuditService } from '@platform/core/audit-module'
import {
  lockStoreForWrite,
  lockStoreScope,
  PrismaService,
  type PrismaTransaction
} from '@platform/core/database'
import {
  OrderLockScopes,
  OrderResourceTypes,
  OrderStatus,
  OrderSummaryEvents,
  type OrderFollowPlan,
  PaymentMethod,
  PaymentStatus,
  planOrderFollow,
  ShipmentInactiveStatuses,
  ShipmentKind,
  ShipmentLeftStatuses,
  ShipmentStatus
} from '@platform/core/domain'
import { DomainEvents } from '@platform/core/event-bus'
import { type ActorRef, Events } from '@platform/core/events'
import { writeOrderSummaryLine } from '@platform/core/messaging'

import { OrderInventoryService } from './orders-inventory.service'
import { lockOrder } from './orders.support'

// What happened to the order because of its shipment: nothing, a change, or a reason for a person to look
export interface OrderFollowResult {
  shipped: boolean
  delivered: boolean
  paymentCompleted: boolean
  review: boolean
}

interface Applied {
  result: OrderFollowResult
  orderId: string
  orderNumber: string
  from: OrderStatus
  steps: OrderStatus[]
  paymentFrom: PaymentStatus | null
}

const NOTHING: OrderFollowResult = {
  shipped: false,
  delivered: false,
  paymentCompleted: false,
  review: false
}

// The order follows its guide (TDD_17 §4.9): the first package that leaves ships the order, with the stock issue of
// `TDD_16 §4.1`, and the last one that arrives delivers it and completes a cash-on-delivery payment. Everything is derived
// from the status the shipment holds NOW and the one the order holds (`planOrderFollow`), under the lock of the order, so
// the same event heard twice, two events at once and a change that an earlier failure missed all end in the same place. The
// stock movements carry their own idempotency key, so the issue happens once whatever happens above it.
@Injectable()
export class OrderShipmentEffects {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    private readonly stock: OrderInventoryService,
    private readonly logger: PinoLogger
  ) {
    this.logger.setContext(OrderShipmentEffects.name)
  }

  async follow(
    storeId: string,
    shipmentId: string,
    actor: ActorRef,
    // The shipment has just left (an event of this very moment, not a later status of a package already on its way)
    justLeft: boolean
  ): Promise<OrderFollowResult> {
    const outcome = await this.prisma.transaction(async tx => {
      await lockStoreForWrite(tx, storeId)
      const known = await tx.shipment.findFirst({
        where: { id: shipmentId, storeId, kind: ShipmentKind.OUTBOUND },
        select: { orderId: true }
      })
      if (known === null) return null
      const { orderId } = known
      // The order first, as every change of an order does: the engine, a cancel and an edit take the same lock in the same order
      await lockOrder(tx, storeId, orderId)
      const order = await tx.order.findFirstOrThrow({
        where: { id: orderId, storeId },
        select: {
          orderNumber: true,
          status: true,
          shippedAt: true,
          paymentMethod: true,
          paymentStatus: true,
          conversationId: true,
          totalCents: true,
          currency: true,
          _count: { select: { items: true } }
        }
      })
      // Every package of the order that is not over, the one that announced the change included: the order is judged by all
      const live = await tx.shipment.findMany({
        where: {
          orderId,
          storeId,
          kind: ShipmentKind.OUTBOUND,
          status: { notIn: [...ShipmentInactiveStatuses] }
        },
        select: { status: true }
      })
      const from = order.status as OrderStatus
      const plan: OrderFollowPlan = planOrderFollow({
        orderStatus: from,
        liveShipments: live.map(row => row.status as ShipmentStatus)
      })
      const common = { storeId, orderId, orderNumber: order.orderNumber, actor }
      const idle = (review: boolean): Applied => ({
        result: { ...NOTHING, review },
        orderId,
        orderNumber: order.orderNumber,
        from,
        steps: [],
        paymentFrom: null
      })
      if (plan.review) {
        // A package that left for an order that cannot follow it: said once, when it leaves, not at every later status
        if (justLeft) await this.askForReview(tx, storeId, shipmentId, actor)
        return idle(justLeft)
      }
      if (!plan.ship && !plan.deliver) return idle(false)

      const createdBy = actor.type === 'user' ? actor.id : null
      const moments = await this.momentsOf(tx, storeId, orderId, order.shippedAt)
      const steps: OrderStatus[] = []
      const data: Parameters<typeof tx.order.update>[0]['data'] = {}
      let paymentFrom: PaymentStatus | null = null
      if (plan.ship) {
        // The stock leaves with the package: take the allocation of the store before the levels, as the hand-made change does
        await lockStoreScope(tx, storeId, OrderLockScopes.ALLOCATION)
        await this.stock.issue(tx, storeId, orderId, createdBy)
        data.status = OrderStatus.SHIPPED
        data.shippedAt = moments.shippedAt
        steps.push(OrderStatus.SHIPPED)
      }
      if (plan.deliver) {
        data.status = OrderStatus.DELIVERED
        data.deliveredAt = moments.deliveredAt
        steps.push(OrderStatus.DELIVERED)
        const payment = order.paymentStatus as PaymentStatus
        // The carrier collected the cash: the payment of a cash-on-delivery order is complete (§4.4)
        if (
          order.paymentMethod === String(PaymentMethod.CASH_ON_DELIVERY) &&
          (payment === PaymentStatus.PENDING || payment === PaymentStatus.FAILED)
        ) {
          data.paymentStatus = PaymentStatus.COMPLETED
          paymentFrom = payment
        }
      }
      await tx.order.update({ where: { id: orderId, storeId }, data })

      let previous = from
      for (const step of steps) {
        if (order.conversationId !== null) {
          await writeOrderSummaryLine(tx, storeId, order.conversationId, {
            event: OrderSummaryEvents.STATUS_CHANGED,
            orderId,
            orderNumber: order.orderNumber,
            status: step,
            previousStatus: previous,
            totalCents: order.totalCents,
            currency: order.currency,
            itemCount: order._count.items,
            actor
          })
        }
        this.events.publish(tx, Events.ORDER_STATUS_CHANGED, {
          ...common,
          from: previous,
          to: step,
          // The package says what the customer is told, not this change of the order (the actor is the person who moved the package,
          // when one did, so only this marker tells the change apart from one made by hand)
          notifyCustomer: false
        })
        if (step === OrderStatus.SHIPPED) this.events.publish(tx, Events.ORDER_SHIPPED, common)
        if (step === OrderStatus.DELIVERED) this.events.publish(tx, Events.ORDER_DELIVERED, common)
        previous = step
      }
      if (paymentFrom !== null) {
        const payment = { ...common, from: paymentFrom, to: PaymentStatus.COMPLETED }
        this.events.publish(tx, Events.ORDER_PAYMENT_RECORDED, payment)
        this.events.publish(tx, Events.ORDER_PAYMENT_STATUS_CHANGED, payment)
      }
      const applied: Applied = {
        result: {
          shipped: plan.ship,
          delivered: plan.deliver,
          paymentCompleted: paymentFrom !== null,
          review: false
        },
        orderId,
        orderNumber: order.orderNumber,
        from,
        steps,
        paymentFrom
      }
      return applied
    })
    if (outcome === null) return NOTHING
    // The audit entries leave after the commit, as those of a hand-made change do
    const who =
      actor.type === 'user' && actor.id !== null ? { userId: actor.id } : { system: true as const }
    let previous: OrderStatus = outcome.from
    for (const step of outcome.steps) {
      this.audit.log({
        action: AuditAction.ORDER_STATUS_CHANGED,
        actor: who,
        storeId,
        resourceType: OrderResourceTypes.ORDER,
        resourceId: outcome.orderId,
        metadata: {
          orderNumber: outcome.orderNumber,
          from: previous,
          to: step,
          shipmentId,
          followedShipment: true
        }
      })
      previous = step
    }
    if (outcome.paymentFrom !== null) {
      this.audit.log({
        action: AuditAction.ORDER_PAYMENT_RECORDED,
        actor: who,
        storeId,
        resourceType: OrderResourceTypes.ORDER,
        resourceId: outcome.orderId,
        metadata: {
          orderNumber: outcome.orderNumber,
          status: PaymentStatus.COMPLETED,
          shipmentId,
          followedShipment: true
        }
      })
      this.audit.log({
        action: AuditAction.ORDER_PAYMENT_STATUS_CHANGED,
        actor: who,
        storeId,
        resourceType: OrderResourceTypes.ORDER,
        resourceId: outcome.orderId,
        metadata: { from: outcome.paymentFrom, to: PaymentStatus.COMPLETED, shipmentId }
      })
    }
    return outcome.result
  }

  // The moments the order shipped and arrived, from the history of its packages: the first applied event that says one left and
  // the last that says one arrived. Only the lines that moved a shipment count (they carry `from`): a late or out-of-order event
  // is kept in the history and says nothing about the order. Never in the future, and never before the order shipped: the same
  // two limits the hand-made path holds.
  private async momentsOf(
    tx: PrismaTransaction,
    storeId: string,
    orderId: string,
    orderShippedAt: Date | null
  ): Promise<{ shippedAt: Date; deliveredAt: Date }> {
    const rows = await tx.shipmentEvent.findMany({
      where: {
        storeId,
        shipment: { orderId, storeId, kind: ShipmentKind.OUTBOUND },
        status: { in: [...ShipmentLeftStatuses] }
      },
      orderBy: { occurredAt: 'asc' },
      select: { status: true, occurredAt: true, payload: true }
    })
    const applied = rows.filter(
      row =>
        typeof row.payload === 'object' &&
        row.payload !== null &&
        !Array.isArray(row.payload) &&
        'from' in row.payload
    )
    const now = new Date()
    const bound = (moment: Date | undefined, floor: Date): Date => {
      const chosen = moment ?? floor
      return new Date(Math.min(Math.max(chosen.getTime(), floor.getTime()), now.getTime()))
    }
    const shippedAt =
      orderShippedAt ??
      new Date(Math.min(applied[0]?.occurredAt.getTime() ?? now.getTime(), now.getTime()))
    const arrivals = applied.filter(row => row.status === String(ShipmentStatus.DELIVERED))
    const deliveredAt = bound(arrivals.at(-1)?.occurredAt, shippedAt)
    return { shippedAt, deliveredAt }
  }

  private async askForReview(
    tx: PrismaTransaction,
    storeId: string,
    shipmentId: string,
    actor: ActorRef
  ): Promise<void> {
    const row = await tx.shipment.findFirstOrThrow({
      where: { id: shipmentId, storeId },
      select: { orderId: true, connectionId: true, order: { select: { orderNumber: true } } }
    })
    this.events.publish(tx, Events.SHIPMENT_REQUIRES_REVIEW, {
      storeId,
      shipmentId,
      orderId: row.orderId,
      orderNumber: row.order.orderNumber,
      connectionId: row.connectionId,
      actor
    })
  }

  // A failure of the effects must be seen, never swallowed: the shipment is committed already, so it is logged and the
  // team is told that this package needs a look
  async reportFailure(
    storeId: string,
    shipmentId: string,
    actor: ActorRef,
    error: unknown
  ): Promise<void> {
    this.logger.error(
      { err: error instanceof Error ? error.message : undefined, shipmentId },
      'the order could not follow its shipment'
    )
    try {
      await this.prisma.transaction(tx => this.askForReview(tx, storeId, shipmentId, actor))
    } catch (inner) {
      this.logger.error(
        { err: inner instanceof Error ? inner.message : undefined, shipmentId },
        'the review notice of a shipment could not be raised'
      )
    }
  }
}
