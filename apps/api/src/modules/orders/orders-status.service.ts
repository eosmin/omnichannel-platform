import { Injectable } from '@nestjs/common'
import { PinoLogger } from 'nestjs-pino'

import { AuditAction } from '@platform/core/audit'
import { AuditService } from '@platform/core/audit-module'
import { type Permission, Permissions } from '@platform/core/auth'
import {
  lockStoreForWrite,
  lockStoreScope,
  PrismaService,
  type PrismaTransaction
} from '@platform/core/database'
import {
  canCancelOrder,
  type ChangeOrderStatusInput,
  checkOrderConfirmation,
  checkOrderTransition,
  checkPaymentChange,
  checkPriceDecision,
  isPriceApprovalBlocking,
  MediaStatus,
  OrderConfirmationChannel,
  OrderConflicts,
  OrderEditablePriceStatuses,
  OrderLockScopes,
  OrderSummaryEvents,
  OrderStatus,
  PaymentMethod,
  PaymentStatus,
  PriceApprovalStatus,
  type RecordOrderPaymentInput
} from '@platform/core/domain'
import {
  errorName,
  ErrorCodes,
  HttpStatusCodes,
  PlatformException,
  resourceNotFound
} from '@platform/core/errors'
import { DomainEvents } from '@platform/core/event-bus'
import { Events } from '@platform/core/events'
import { writeOrderSummaryLine } from '@platform/core/messaging'
import { MediaPurpose } from '@platform/core/storage'

import type { Actor } from '../tenancy'

import { OrderGuides, type VoidedGuides } from './order-guides.service'
import { OrderInventoryService } from './orders-inventory.service'
import type { ConfirmOrdersBulkBody } from './orders.schemas'
import { OrdersService } from './orders.service'
import {
  actorRef,
  assertHolds,
  hasActiveGuide,
  lockOrder,
  orderRefusal,
  recordOrderAudit
} from './orders.support'
import type { OrderDetailView } from './orders.views'

// How far in the future a delivery moment may be: a clock that runs a little fast is not a lie about the future
const DELIVERY_CLOCK_ALLOWANCE_MS = 5 * 60 * 1000

// What a bulk change tells: the orders that changed and, for each one that did not, our code for the reason
export interface OrdersBulkResult {
  succeeded: string[]
  failed: { id: string; code: string }[]
}

type PriceDecision = typeof PriceApprovalStatus.APPROVED | typeof PriceApprovalStatus.REJECTED

// The life of an order: its status and the stock that goes with each change (TDD_16 §4.1), the decisions on a price
// (TDD_17 §4.13) and the payments recorded by hand. Every change locks the order first and is one transaction with
// its stock movements, so it commits or fails as a whole; the audit entries leave after the commit.
@Injectable()
export class OrdersStatusService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    private readonly stock: OrderInventoryService,
    private readonly orders: OrdersService,
    private readonly guides: OrderGuides,
    private readonly logger: PinoLogger
  ) {
    this.logger.setContext(OrdersStatusService.name)
  }

  async changeStatus(
    storeId: string,
    orderId: string,
    body: ChangeOrderStatusInput,
    actor: Actor,
    held: readonly Permission[]
  ): Promise<OrderDetailView> {
    await this.applyStatus(storeId, orderId, body, actor, held)
    return this.orders.get(storeId, orderId, held)
  }

  // "Mark as confirmed" over many orders of the list. Each is a change of its own (its own lock and transaction, its own
  // audit entry), so one that cannot be confirmed (already confirmed, cancelled, a price waiting for approval, an order of
  // another store, which is one that does not exist) is reported with its code and does not stop the others.
  async confirmBulk(
    storeId: string,
    ids: readonly string[],
    via: ConfirmOrdersBulkBody['via'],
    actor: Actor,
    held: readonly Permission[]
  ): Promise<OrdersBulkResult> {
    assertHolds(held, Permissions.ORDERS_CONFIRM)
    const result: OrdersBulkResult = { succeeded: [], failed: [] }
    // One at a time: each change takes the lock of the store, and two that ran together would only wait for each other
    for (const id of ids) {
      try {
        await this.applyStatus(
          storeId,
          id,
          { status: OrderStatus.CONFIRMED, confirmedVia: via },
          actor,
          held
        )
        result.succeeded.push(id)
      } catch (error) {
        const code = error instanceof PlatformException ? error.code : ErrorCodes.INTERNAL_ERROR
        // What is ours (a deadlock, a timeout, a 5xx) is said here; the caller gets the code only
        if (
          !(error instanceof PlatformException) ||
          error.statusCode >= HttpStatusCodes.INTERNAL_SERVER_ERROR
        ) {
          this.logger.error(
            { orderId: id, errorName: errorName(error) },
            'an order of a bulk confirmation was not confirmed'
          )
        }
        result.failed.push({ id, code })
      }
    }
    return result
  }

  private async applyStatus(
    storeId: string,
    orderId: string,
    body: ChangeOrderStatusInput,
    actor: Actor,
    held: readonly Permission[]
  ): Promise<void> {
    // The route asks for the permission to change the status; confirming and cancelling have their own (TDD_17 §4.3):
    // whichever route reaches this, the one of the target applies
    if (body.status === OrderStatus.CONFIRMED) assertHolds(held, Permissions.ORDERS_CONFIRM)
    if (body.status === OrderStatus.CANCELLED) assertHolds(held, Permissions.ORDERS_CANCEL)
    // Putting units back on the shelf is a movement of stock: whoever chooses it may adjust stock (the return flow of
    // Step 4.12 will own this decision)
    if (body.restock === true) assertHolds(held, Permissions.INVENTORY_ADJUST)

    const result = await this.prisma.transaction(async tx => {
      await lockStoreForWrite(tx, storeId)
      await lockOrder(tx, storeId, orderId)
      const order = await tx.order.findFirstOrThrow({
        where: { id: orderId, storeId },
        select: {
          orderNumber: true,
          status: true,
          priceApprovalStatus: true,
          shippedAt: true,
          conversationId: true,
          totalCents: true,
          currency: true,
          _count: { select: { items: true } }
        }
      })
      const from = order.status as OrderStatus
      const approval = order.priceApprovalStatus as PriceApprovalStatus
      const to = body.status
      let voided: VoidedGuides = { shipmentIds: [], jobs: [] }

      // Every effect on stock takes the allocation of the store before the levels, as a creation and an edit do
      if (
        to === OrderStatus.CANCELLED ||
        to === OrderStatus.SHIPPED ||
        (to === OrderStatus.RETURNED && body.restock === true)
      ) {
        await lockStoreScope(tx, storeId, OrderLockScopes.ALLOCATION)
      }
      if (to === OrderStatus.CONFIRMED) {
        const verdict = checkOrderConfirmation(from, approval)
        if (!verdict.ok) throw orderRefusal(verdict.code)
      } else if (to === OrderStatus.CANCELLED) {
        // The table says which statuses can be cancelled; the code says why a refusal is about the cancellation
        if (!canCancelOrder(from)) throw orderRefusal(ErrorCodes.ORDER_CANNOT_BE_CANCELLED)
        // The guides that are only a label are voided with the order (TDD_17 §4.8); one whose outcome is unknown may exist at the
        // carrier, and one that was picked up cannot be called back: those refuse
        voided = await this.guides.voidLive(tx, storeId, orderId, actorRef(actor))
      } else {
        // The guide decides when the goods leave and arrive: a hand-made SHIPPED or DELIVERED would skip the stock issue and the
        // payment effect that the shipment follows (TDD_17 §4.9). The order follows its guide through its own path
        // (`OrderShipmentEffects`, which is not this route and so is not stopped by it): a person who has to move the order
        // moves the shipment (a manual status of the guide has the same effects), and without a live guide the order is theirs.
        if (
          (to === OrderStatus.SHIPPED || to === OrderStatus.DELIVERED) &&
          (await hasActiveGuide(tx, storeId, orderId))
        ) {
          throw orderRefusal(ErrorCodes.ORDER_STATUS_DRIVEN_BY_SHIPMENT)
        }
        const verdict = checkOrderTransition(from, to)
        if (!verdict.ok) throw orderRefusal(verdict.code)
        // The goods do not leave the warehouse with a price nobody approved (TDD_17 §4.13 holds the guide back the same way)
        if (
          (to === OrderStatus.PREPARING || to === OrderStatus.SHIPPED) &&
          isPriceApprovalBlocking(approval)
        ) {
          throw orderRefusal(ErrorCodes.ORDER_PRICE_APPROVAL_PENDING)
        }
      }

      const now = new Date()
      const data: Parameters<PrismaTransaction['order']['update']>[0]['data'] = { status: to }
      switch (to) {
        case OrderStatus.CONFIRMED:
          Object.assign(data, {
            confirmedAt: now,
            confirmedBy: actor.userId,
            confirmedVia: body.confirmedVia ?? OrderConfirmationChannel.OTHER
          })
          break
        case OrderStatus.CANCELLED:
          // Before SHIPPED the stock was only promised: the reservations go back
          await this.stock.release(tx, storeId, orderId, actor.userId)
          Object.assign(data, {
            cancellationReason: body.cancellationReason ?? null,
            cancelledBy: actor.userId,
            cancelledAt: now
          })
          break
        case OrderStatus.SHIPPED:
          await this.stock.issue(tx, storeId, orderId, actor.userId)
          Object.assign(data, { shippedAt: now })
          break
        case OrderStatus.DELIVERED: {
          const deliveredAt = body.deliveredAt === undefined ? now : new Date(body.deliveredAt)
          if (deliveredAt.getTime() > now.getTime() + DELIVERY_CLOCK_ALLOWANCE_MS) {
            throw new PlatformException(
              ErrorCodes.VALIDATION_FAILED,
              'an order cannot be delivered in the future',
              HttpStatusCodes.BAD_REQUEST,
              { conflict: OrderConflicts.DELIVERED_IN_THE_FUTURE }
            )
          }
          // Nothing is delivered before it left (a clock allowance is not needed here: the moment is the agent's)
          if (order.shippedAt !== null && deliveredAt.getTime() < order.shippedAt.getTime()) {
            throw new PlatformException(
              ErrorCodes.VALIDATION_FAILED,
              'an order cannot be delivered before it shipped',
              HttpStatusCodes.BAD_REQUEST,
              { conflict: OrderConflicts.DELIVERED_BEFORE_SHIPPED }
            )
          }
          if (body.proofOfDeliveryMediaId !== undefined) {
            await this.assertOrderFile(tx, storeId, orderId, body.proofOfDeliveryMediaId)
            Object.assign(data, { proofOfDeliveryMediaId: body.proofOfDeliveryMediaId })
          }
          Object.assign(data, { deliveredAt })
          break
        }
        case OrderStatus.RETURNED:
          // An order with no OrderReturn (Step 4.12): the agent chooses to put the units back on the shelf or not
          if (body.restock === true) await this.stock.restock(tx, storeId, orderId, actor.userId)
          break
        case OrderStatus.PENDING_CONFIRMATION:
        case OrderStatus.PREPARING:
          break
      }
      await tx.order.update({ where: { id: orderId, storeId }, data })

      const common = {
        storeId,
        orderId,
        orderNumber: order.orderNumber,
        actor: actorRef(actor)
      }
      // The thread of the conversation the order came from says so, in the same transaction
      if (order.conversationId !== null) {
        await writeOrderSummaryLine(tx, storeId, order.conversationId, {
          event: OrderSummaryEvents.STATUS_CHANGED,
          orderId,
          orderNumber: order.orderNumber,
          status: to,
          previousStatus: from,
          totalCents: order.totalCents,
          currency: order.currency,
          itemCount: order._count.items,
          actor: actorRef(actor)
        })
      }
      this.events.publish(tx, Events.ORDER_STATUS_CHANGED, { ...common, from, to })
      if (to === OrderStatus.CONFIRMED) this.events.publish(tx, Events.ORDER_CONFIRMED, common)
      if (to === OrderStatus.SHIPPED) this.events.publish(tx, Events.ORDER_SHIPPED, common)
      if (to === OrderStatus.DELIVERED) this.events.publish(tx, Events.ORDER_DELIVERED, common)
      if (to === OrderStatus.CANCELLED) this.events.publish(tx, Events.ORDER_CANCELLED, common)
      return { from, orderNumber: order.orderNumber, voided }
    })

    // The carrier is asked once the order has committed (the shipments are CANCEL_PENDING until the worker does)
    await this.guides.hand(storeId, result.voided, actor.userId)

    const trail = { storeId, orderId, actor }
    recordOrderAudit(this.audit, AuditAction.ORDER_STATUS_CHANGED, trail, {
      orderNumber: result.orderNumber,
      from: result.from,
      to: body.status,
      ...(body.restock === undefined ? {} : { restock: body.restock }),
      ...(body.deliveredAt === undefined ? {} : { deliveredAt: body.deliveredAt }),
      ...(body.proofOfDeliveryMediaId === undefined ? {} : { hasProof: true })
    })
    if (body.status === OrderStatus.CONFIRMED) {
      recordOrderAudit(this.audit, AuditAction.ORDER_CONFIRMED, trail, {
        via: body.confirmedVia ?? OrderConfirmationChannel.OTHER
      })
    }
    if (body.status === OrderStatus.CANCELLED) {
      recordOrderAudit(this.audit, AuditAction.ORDER_CANCELLED, trail, {
        reason: body.cancellationReason ?? null,
        ...(result.voided.shipmentIds.length === 0
          ? {}
          : { shipmentsVoided: result.voided.shipmentIds })
      })
    }
  }

  // Approve or reject the price of an order that waits for it (TDD_17 §4.13). Nobody approves their own request.
  async decidePrice(
    storeId: string,
    orderId: string,
    decision: PriceDecision,
    reason: string | undefined,
    actor: Actor,
    held: readonly Permission[]
  ): Promise<OrderDetailView> {
    const result = await this.prisma.transaction(async tx => {
      await lockStoreForWrite(tx, storeId)
      await lockOrder(tx, storeId, orderId)
      const order = await tx.order.findFirstOrThrow({
        where: { id: orderId, storeId },
        select: {
          orderNumber: true,
          discountCents: true,
          shippingCents: true,
          status: true,
          priceApprovalStatus: true,
          priceApprovalRequestedBy: true
        }
      })
      // A price is decided while the order can still change: not after it shipped, was delivered, cancelled or returned
      if (!OrderEditablePriceStatuses.includes(order.status as OrderStatus)) {
        throw orderRefusal(ErrorCodes.ORDER_PRICE_APPROVAL_NOT_PENDING)
      }
      const verdict = checkPriceDecision({
        status: order.priceApprovalStatus as PriceApprovalStatus,
        requestedBy: order.priceApprovalRequestedBy,
        approverId: actor.userId,
        decision
      })
      if (!verdict.ok) throw orderRefusal(verdict.code)
      const approved = decision === PriceApprovalStatus.APPROVED
      await tx.order.update({
        where: { id: orderId, storeId },
        data: {
          priceApprovalStatus: decision,
          // What the approver accepted is what the order costs now: an edit that moves either goes back to pending
          ...(approved
            ? {
                priceApprovedBy: actor.userId,
                priceApprovedAt: new Date(),
                priceApprovedDiscountCents: order.discountCents,
                priceApprovedShippingCents: order.shippingCents
              }
            : {})
        }
      })
      this.events.publish(
        tx,
        approved ? Events.ORDER_PRICE_APPROVED : Events.ORDER_PRICE_REJECTED,
        {
          storeId,
          orderId,
          orderNumber: order.orderNumber,
          actor: actorRef(actor)
        }
      )
      return order
    })
    recordOrderAudit(
      this.audit,
      decision === PriceApprovalStatus.APPROVED
        ? AuditAction.ORDER_PRICE_APPROVED
        : AuditAction.ORDER_PRICE_REJECTED,
      { storeId, orderId, actor },
      {
        orderNumber: result.orderNumber,
        discountCents: result.discountCents,
        shippingCents: result.shippingCents,
        requestedBy: result.priceApprovalRequestedBy,
        reason: reason ?? null
      }
    )
    return this.orders.get(storeId, orderId, held)
  }

  // A payment recorded by hand (v1.2 has no online gateway): how the money came, in what state, the number of the
  // transfer or deposit and the receipt. It never changes how the order was sold (Order.paymentMethod).
  async recordPayment(
    storeId: string,
    orderId: string,
    body: RecordOrderPaymentInput,
    actor: Actor,
    held: readonly Permission[]
  ): Promise<OrderDetailView> {
    const result = await this.prisma.transaction(async tx => {
      await lockStoreForWrite(tx, storeId)
      await lockOrder(tx, storeId, orderId)
      const order = await tx.order.findFirstOrThrow({
        where: { id: orderId, storeId },
        select: {
          orderNumber: true,
          status: true,
          paymentMethod: true,
          paymentStatus: true,
          priceApprovalStatus: true,
          paymentReference: true,
          paymentProofMediaId: true
        }
      })
      const from = order.paymentStatus as PaymentStatus
      // Money is not taken as paid for a price nobody has approved: the lines and the fee are fixed once it is
      if (
        body.status === PaymentStatus.COMPLETED &&
        isPriceApprovalBlocking(order.priceApprovalStatus as PriceApprovalStatus)
      ) {
        throw orderRefusal(ErrorCodes.ORDER_PRICE_APPROVAL_PENDING)
      }
      const verdict = checkPaymentChange({
        orderStatus: order.status as OrderStatus,
        orderPaymentMethod: order.paymentMethod as PaymentMethod,
        from,
        to: body.status
      })
      if (!verdict.ok) throw orderRefusal(verdict.code)
      if (body.proofMediaId !== undefined) {
        await this.assertOrderFile(tx, storeId, orderId, body.proofMediaId)
      }
      await tx.order.update({
        where: { id: orderId, storeId },
        data: {
          paymentStatus: body.status,
          // What the record does not say stays as it was: a reference added later to a payment that is still pending
          ...(body.reference === undefined ? {} : { paymentReference: body.reference }),
          ...(body.proofMediaId === undefined ? {} : { paymentProofMediaId: body.proofMediaId })
        }
      })
      const payload = {
        storeId,
        orderId,
        orderNumber: order.orderNumber,
        actor: actorRef(actor),
        from,
        to: body.status
      }
      this.events.publish(tx, Events.ORDER_PAYMENT_RECORDED, payload)
      if (from !== body.status) {
        this.events.publish(tx, Events.ORDER_PAYMENT_STATUS_CHANGED, payload)
      }
      return { order, from }
    })
    const trail = { storeId, orderId, actor }
    recordOrderAudit(this.audit, AuditAction.ORDER_PAYMENT_RECORDED, trail, {
      orderNumber: result.order.orderNumber,
      method: body.method,
      status: body.status,
      reference: body.reference ?? null,
      hasProof: body.proofMediaId !== undefined
    })
    if (result.from !== body.status) {
      recordOrderAudit(this.audit, AuditAction.ORDER_PAYMENT_STATUS_CHANGED, trail, {
        from: result.from,
        to: body.status
      })
    }
    return this.orders.get(storeId, orderId, held)
  }

  // A file that belongs to this order: scanned clean, of the order's purpose, attached to it. A file of another order or
  // store, of another purpose or one the scan has not cleared is a file that does not exist.
  private async assertOrderFile(
    tx: PrismaTransaction,
    storeId: string,
    orderId: string,
    mediaId: string
  ): Promise<void> {
    const file = await tx.media.findFirst({
      where: {
        id: mediaId,
        storeId,
        orderId,
        purpose: MediaPurpose.ORDER,
        status: MediaStatus.CLEAN
      },
      select: { id: true }
    })
    if (file === null) throw resourceNotFound('media')
  }
}
