import { Injectable } from '@nestjs/common'

import { AuditAction, type AuditActionType } from '@platform/core/audit'
import { AuditService } from '@platform/core/audit-module'
import {
  lockStoreForWrite,
  lockStoreScope,
  PrismaService,
  type PrismaTransaction
} from '@platform/core/database'
import {
  type ApproveReturnBody,
  canMoveReturn,
  checkReturnableOrder,
  checkReturnLines,
  coversEveryUnit,
  type CompleteReturnBody,
  type CreateReturnBody,
  defaultRestockWarehouse,
  exchangeCreditCents,
  InventoryReferenceType,
  OrderLockScopes,
  OrderReturnCondition,
  OrderReturnStatus,
  OrderReturnType,
  OrderResourceTypes,
  OrderStatus,
  PaymentStatus,
  type ReceiveReturnBody,
  refundRoom,
  ReturnResourceTypes,
  returnMovementKey,
  movementsOfReceipt,
  ShipmentEventNotes,
  ShipmentEventSource,
  ShippingPayer,
  ShipmentInactiveStatuses,
  ShipmentKind,
  ShipmentStatus,
  unitsHeld
} from '@platform/core/domain'
import {
  ErrorCodes,
  HttpStatusCodes,
  PlatformException,
  resourceNotFound
} from '@platform/core/errors'
import { DomainEvents } from '@platform/core/event-bus'
import { type ActorRef, Events } from '@platform/core/events'
import {
  InventoryService,
  type MovementInput,
  warehouseInactive,
  warehouseNotLinked
} from '@platform/core/inventory'

import { type ReplacementOrderMade, ReturnOrderPort } from './return-order.port'
import { isShipmentTransitionAllowed } from './shipment-rules'
import { ShipmentWrites } from './shipment-writes'

// The shipments a package can be scanned from (TDD_17 §4.16): the carrier's status often lags the physical return
const SCANNABLE_STATUSES: readonly ShipmentStatus[] = [
  ShipmentStatus.IN_TRANSIT,
  ShipmentStatus.OUT_FOR_DELIVERY,
  ShipmentStatus.FAILED_ATTEMPT,
  ShipmentStatus.RETURNING,
  ShipmentStatus.RETURNED
]

// Who did it, and from where: what the audit entry of every change records (the caller's `Actor`)
export interface ReturnActor {
  userId: string
  storeId: string
  ipAddress?: string | undefined
  userAgent?: string | undefined
}

const actorRef = (actor: ReturnActor): ActorRef => ({ type: 'user', id: actor.userId })

function invalid(
  message: string,
  code: typeof ErrorCodes.RETURN_RECEIPT_INVALID | typeof ErrorCodes.VALIDATION_INVALID_INPUT
) {
  return new PlatformException(code, message, HttpStatusCodes.BAD_REQUEST)
}

function conflict(
  code: (typeof ErrorCodes)[keyof typeof ErrorCodes],
  message: string,
  metadata?: Record<string, unknown>
) {
  return new PlatformException(code, message, HttpStatusCodes.CONFLICT, metadata)
}

// What a package that was scanned says about itself (TDD_17 §4.16)
export interface ScannedReturnInput {
  shipmentId: string
  reason: string
  notes?: string | undefined
  // Omitted, every unit of the order that is not already in a return comes back
  lines?:
    | readonly {
        orderItemId: string
        quantity: number
        condition: OrderReturnCondition
        restockWarehouseId?: string | undefined
      }[]
    | undefined
  // The condition of the lines that name none
  condition: OrderReturnCondition
  refundAmountCents?: number | undefined
}

interface LoadedReturn {
  id: string
  orderId: string
  type: OrderReturnType
  status: OrderReturnStatus
  orderNumber: string
  lines: { id: string; orderItemId: string; quantity: number }[]
}

// The returns of the store (TDD_17 §4.11): the one writer of `OrderReturn.status`. Every change locks the store, the order
// and the return, and is one transaction with its stock movements, so a receipt commits or fails as a whole and counts the
// units once (each movement carries the key `return:{returnId}:{orderItemId}:{movement}`). The audit entries leave after
// the commit.
@Injectable()
export class ReturnsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    private readonly inventory: InventoryService,
    private readonly orders: ReturnOrderPort,
    private readonly shipmentWrites: ShipmentWrites
  ) {}

  // ------------------------------------------------------------------------------------------ the life of a return

  async create(storeId: string, body: CreateReturnBody, actor: ReturnActor): Promise<string> {
    const created = await this.prisma.transaction(async tx => {
      await lockStoreForWrite(tx, storeId)
      await this.orders.lockOrder(tx, storeId, body.orderId)
      const order = await tx.order.findFirstOrThrow({
        where: { id: body.orderId, storeId },
        select: {
          orderNumber: true,
          status: true,
          items: { select: { id: true, quantity: true } },
          shipments: {
            where: { kind: ShipmentKind.OUTBOUND },
            select: { status: true }
          }
        }
      })
      const eligible = checkReturnableOrder({
        orderStatus: order.status as OrderStatus,
        outboundStatuses: order.shipments.map(shipment => shipment.status as ShipmentStatus)
      })
      if (!eligible.ok) throw conflict(eligible.code, 'the order cannot be returned now')
      const held = unitsHeld(await this.returnsOf(tx, storeId, body.orderId))
      this.assertLines(order.items, held, body.lines)
      const settings = await tx.storeSettings.findUnique({
        where: { storeId },
        select: { returnShippingPayer: true }
      })
      const row = await tx.orderReturn.create({
        data: {
          storeId,
          orderId: body.orderId,
          type: body.type,
          reason: body.reason,
          status: OrderReturnStatus.REQUESTED,
          shippingPayer:
            body.shippingPayer ?? settings?.returnShippingPayer ?? ShippingPayer.SENDER,
          notes: body.notes ?? null,
          createdBy: actor.userId
        },
        select: { id: true }
      })
      await tx.orderReturnLine.createMany({
        data: body.lines.map(line => ({
          storeId,
          returnId: row.id,
          orderItemId: line.orderItemId,
          quantity: line.quantity
        }))
      })
      this.events.publish(tx, Events.RETURN_REQUESTED, {
        storeId,
        orderId: body.orderId,
        orderNumber: order.orderNumber,
        returnId: row.id,
        actor: actorRef(actor)
      })
      return { id: row.id, orderNumber: order.orderNumber }
    })
    this.record(AuditAction.RETURN_CREATED, storeId, created.id, actor, {
      orderNumber: created.orderNumber,
      type: body.type,
      reason: body.reason,
      lines: body.lines.length
    })
    return created.id
  }

  // Approving a refund only moves the status. Approving an exchange also makes its replacement order (TDD_17 §4.11), in the same
  // transaction: a replacement that cannot be made (no stock, a fee out of range) leaves the return as it was. The credit is the
  // value of the returned lines at the price they were sold at; the replacement is what the agent picked, so its total is the price
  // difference, and what the credit has left over is the refund the owner settles by hand.
  async approve(
    storeId: string,
    returnId: string,
    body: ApproveReturnBody,
    actor: ReturnActor
  ): Promise<string> {
    const result = await this.prisma.transaction(async tx => {
      const loaded = await this.lock(tx, storeId, returnId, true)
      this.assertMove(loaded.status, OrderReturnStatus.APPROVED)
      const isExchange = loaded.type === OrderReturnType.EXCHANGE
      if (isExchange !== (body.replacement !== undefined)) {
        throw invalid(
          isExchange
            ? 'an exchange is approved with its replacement'
            : 'only an exchange has a replacement',
          ErrorCodes.VALIDATION_INVALID_INPUT
        )
      }
      let replacement: ReplacementOrderMade | null = null
      if (body.replacement !== undefined) {
        replacement = await this.orders.createReplacement(
          tx,
          storeId,
          {
            ofOrderId: loaded.orderId,
            returnId,
            creditCents: await this.exchangeCredit(tx, loaded),
            replacement: body.replacement
          },
          actor
        )
      }
      await tx.orderReturn.update({
        where: { id: returnId },
        data: {
          status: OrderReturnStatus.APPROVED,
          ...(replacement === null ? {} : { replacementOrderId: replacement.orderId })
        }
      })
      this.events.publish(tx, Events.RETURN_APPROVED, {
        storeId,
        orderId: loaded.orderId,
        orderNumber: loaded.orderNumber,
        returnId,
        actor: actorRef(actor)
      })
      return { orderNumber: loaded.orderNumber, replacement }
    })
    result.replacement?.afterCommit()
    this.record(AuditAction.RETURN_APPROVED, storeId, returnId, actor, {
      orderNumber: result.orderNumber,
      ...(result.replacement === null
        ? {}
        : {
            replacementOrderId: result.replacement.orderId,
            replacementOrderNumber: result.replacement.orderNumber,
            creditAppliedCents: result.replacement.creditAppliedCents,
            excessCents: result.replacement.excessCents
          })
    })
    return returnId
  }

  async reject(
    storeId: string,
    returnId: string,
    actor: ReturnActor,
    notes: string | undefined
  ): Promise<string> {
    const result = await this.move(storeId, returnId, OrderReturnStatus.REJECTED, actor, notes)
    this.record(AuditAction.RETURN_REJECTED, storeId, returnId, actor, {
      orderNumber: result.orderNumber
    })
    return returnId
  }

  async cancel(
    storeId: string,
    returnId: string,
    actor: ReturnActor,
    notes: string | undefined
  ): Promise<string> {
    const result = await this.move(storeId, returnId, OrderReturnStatus.CANCELLED, actor, notes)
    this.record(AuditAction.RETURN_CANCELLED, storeId, returnId, actor, {
      orderNumber: result.orderNumber
    })
    return returnId
  }

  async markInTransit(storeId: string, returnId: string, actor: ReturnActor): Promise<string> {
    const result = await this.move(storeId, returnId, OrderReturnStatus.IN_TRANSIT, actor, null)
    this.record(AuditAction.RETURN_IN_TRANSIT, storeId, returnId, actor, {
      orderNumber: result.orderNumber
    })
    return returnId
  }

  // A person inspected the goods: each line gets its condition and, for a resellable one, the warehouse it goes back to. The
  // stock moves in the same transaction as the status.
  async receive(
    storeId: string,
    returnId: string,
    body: ReceiveReturnBody,
    actor: ReturnActor
  ): Promise<string> {
    const result = await this.prisma.transaction(async tx => {
      const loaded = await this.lock(tx, storeId, returnId, true)
      this.assertMove(loaded.status, OrderReturnStatus.RECEIVED)
      return this.applyReceipt(tx, storeId, loaded, body.lines, actor)
    })
    this.record(AuditAction.RETURN_RECEIVED, storeId, returnId, actor, {
      orderNumber: result.orderNumber,
      orderReturned: result.orderReturned
    })
    this.recordOrderReturned(storeId, returnId, actor, result)
    return returnId
  }

  // The goods are back and the person checked them: a refund records the money given back, by hand (the platform processes no
  // payment). It never passes what the customer paid; when it equals the total the payment is REFUNDED.
  async complete(
    storeId: string,
    returnId: string,
    body: CompleteReturnBody,
    actor: ReturnActor
  ): Promise<string> {
    const result = await this.prisma.transaction(async tx => {
      const loaded = await this.lock(tx, storeId, returnId, false)
      this.assertMove(loaded.status, OrderReturnStatus.COMPLETED)
      return this.settle(tx, storeId, loaded, body.refundAmountCents, body.notes, actor)
    })
    this.record(AuditAction.RETURN_COMPLETED, storeId, returnId, actor, {
      orderNumber: result.orderNumber
    })
    if (result.refundCents !== null) {
      this.record(AuditAction.RETURN_REFUND_RECORDED, storeId, returnId, actor, {
        orderNumber: result.orderNumber,
        refundAmountCents: result.refundCents,
        paymentRefunded: result.paymentRefunded
      })
    }
    this.recordPaymentRefunded(storeId, returnId, actor, result)
    return returnId
  }

  // A package scanned at the reception (TDD_17 §4.16), one transaction per package: the return is made, received and completed
  // at once, the shipment goes to RETURNED with a manual event, the stock moves by the condition and the order becomes RETURNED
  // when the units that are back cover it all. Another package of the batch that fails does not undo this one. The customer
  // caution flag is applied by the reception service (PR R2), which calls this and then the flag.
  async receiveFromScan(
    storeId: string,
    input: ScannedReturnInput,
    actor: ReturnActor
  ): Promise<{ returnId: string; orderId: string }> {
    const shipmentRow = await this.prisma.client.shipment.findFirst({
      where: { id: input.shipmentId, storeId },
      select: { orderId: true, kind: true, returnId: true }
    })
    if (shipmentRow === null) throw resourceNotFound('shipment')
    // The package of a return leg belongs to the return that made it: it is received through that return, never as a new one
    if ((shipmentRow.kind as ShipmentKind) === ShipmentKind.RETURN) {
      return this.receiveReturnLeg(storeId, input, shipmentRow.returnId, actor)
    }
    const done = await this.prisma.transaction(async tx => {
      await lockStoreForWrite(tx, storeId)
      await this.orders.lockOrder(tx, storeId, shipmentRow.orderId)
      await lockStoreScope(tx, storeId, OrderLockScopes.ALLOCATION)
      // The guide is held until the end, as the shipment engine holds it for its own moves
      await tx.$queryRaw`SELECT id FROM shipments WHERE id = ${input.shipmentId} AND store_id = ${storeId} FOR UPDATE`
      const shipment = await tx.shipment.findFirst({
        where: { id: input.shipmentId, storeId },
        select: {
          id: true,
          orderId: true,
          kind: true,
          status: true,
          connectionId: true,
          order: {
            select: {
              orderNumber: true,
              status: true,
              items: { select: { id: true, quantity: true } }
            }
          }
        }
      })
      if (shipment === null) throw resourceNotFound('shipment')
      const from = shipment.status as ShipmentStatus
      // A return leg was taken above; what is left is the package of an outbound guide
      if (
        (shipment.kind as ShipmentKind) !== ShipmentKind.OUTBOUND ||
        !SCANNABLE_STATUSES.includes(from)
      ) {
        throw conflict(
          ErrorCodes.RETURN_ORDER_NOT_DELIVERED,
          'the shipment is not one a package comes back from'
        )
      }
      const orderStatus = shipment.order.status as OrderStatus
      if (orderStatus !== OrderStatus.SHIPPED && orderStatus !== OrderStatus.DELIVERED) {
        throw conflict(ErrorCodes.RETURN_ORDER_NOT_DELIVERED, 'the order cannot be returned now')
      }
      const items = shipment.order.items
      // A package does not say which units it holds: the units of "everything" are the order's only when this is its only guide.
      // An order sent in parts needs the lines of the package, or stock that is still on its way would be counted in.
      if (input.lines === undefined) {
        const others = await tx.shipment.count({
          where: {
            storeId,
            orderId: shipment.orderId,
            kind: ShipmentKind.OUTBOUND,
            id: { not: shipment.id },
            status: { notIn: [...ShipmentInactiveStatuses] }
          }
        })
        if (others > 0) {
          throw invalid(
            'an order sent in parts needs the lines of the package',
            ErrorCodes.VALIDATION_INVALID_INPUT
          )
        }
      }
      const held = unitsHeld(await this.returnsOf(tx, storeId, shipment.orderId))
      const lines =
        input.lines === undefined
          ? items
              .map(item => ({
                orderItemId: item.id,
                quantity: item.quantity - (held.get(item.id) ?? 0),
                condition: input.condition,
                restockWarehouseId: undefined as string | undefined
              }))
              .filter(line => line.quantity > 0)
          : input.lines
      if (lines.length === 0) {
        throw conflict(ErrorCodes.RETURN_QUANTITY_EXCEEDS_DELIVERED, 'nothing is left to return')
      }
      this.assertLines(items, held, lines)

      const row = await tx.orderReturn.create({
        data: {
          storeId,
          orderId: shipment.orderId,
          type: OrderReturnType.REFUND,
          reason: input.reason,
          status: OrderReturnStatus.APPROVED,
          shippingPayer: ShippingPayer.SENDER,
          notes: input.notes ?? null,
          createdBy: actor.userId
        },
        select: { id: true }
      })
      await tx.orderReturnLine.createMany({
        data: lines.map(line => ({
          storeId,
          returnId: row.id,
          orderItemId: line.orderItemId,
          quantity: line.quantity
        }))
      })
      const loaded: LoadedReturn = {
        id: row.id,
        orderId: shipment.orderId,
        type: OrderReturnType.REFUND,
        status: OrderReturnStatus.APPROVED,
        orderNumber: shipment.order.orderNumber,
        lines: await tx.orderReturnLine.findMany({
          where: { storeId, returnId: row.id },
          select: { id: true, orderItemId: true, quantity: true }
        })
      }
      const receipt = await this.applyReceipt(
        tx,
        storeId,
        loaded,
        lines.map(line => ({
          orderItemId: line.orderItemId,
          condition: line.condition,
          ...(line.restockWarehouseId === undefined
            ? {}
            : { restockWarehouseId: line.restockWarehouseId })
        })),
        actor
      )
      loaded.status = OrderReturnStatus.RECEIVED
      // The package is back: its shipment says so, with a manual event (a carrier that already said it leaves it as it is)
      if (from !== ShipmentStatus.RETURNED) {
        if (!isShipmentTransitionAllowed(from, ShipmentStatus.RETURNED)) {
          throw conflict(
            ErrorCodes.SHIPPING_INVALID_STATUS_TRANSITION,
            'the shipment cannot be returned now'
          )
        }
        await this.shipmentWrites.move(
          tx,
          {
            shipmentId: shipment.id,
            storeId,
            orderId: shipment.orderId,
            orderNumber: shipment.order.orderNumber,
            connectionId: shipment.connectionId
          },
          from,
          ShipmentStatus.RETURNED,
          {},
          {
            actor: actorRef(actor),
            source: ShipmentEventSource.MANUAL,
            description: ShipmentEventNotes.RECEIVED_AT_WAREHOUSE
          }
        )
      }
      await tx.orderReturn.update({
        where: { id: row.id },
        data: {
          returnShipmentId:
            (shipment.kind as ShipmentKind) === ShipmentKind.RETURN ? shipment.id : null
        }
      })
      const settled = await this.settle(
        tx,
        storeId,
        loaded,
        input.refundAmountCents,
        undefined,
        actor
      )
      return { returnId: row.id, orderId: shipment.orderId, settled, receipt }
    })
    this.record(AuditAction.RETURN_RECEIVED_BY_SCAN, storeId, done.returnId, actor, {
      orderNumber: done.settled.orderNumber,
      shipmentId: input.shipmentId,
      reason: input.reason
    })
    this.recordOrderReturned(storeId, done.returnId, actor, done.receipt)
    this.recordPaymentRefunded(storeId, done.returnId, actor, done.settled)
    if (done.settled.refundCents !== null) {
      this.record(AuditAction.RETURN_REFUND_RECORDED, storeId, done.returnId, actor, {
        orderNumber: done.settled.orderNumber,
        refundAmountCents: done.settled.refundCents,
        paymentRefunded: done.settled.paymentRefunded
      })
    }
    return { returnId: done.returnId, orderId: done.orderId }
  }

  // The package of a return leg was scanned (TDD_17 §4.11, §4.16): the return that made the guide is the one received, with the
  // reason, condition and lines of the scan, and the guide says it arrived. No second return is made, so the units are counted
  // once. The return must be approved or in transit (a receipt of anything else is refused as `receive` refuses it).
  private async receiveReturnLeg(
    storeId: string,
    input: ScannedReturnInput,
    returnId: string | null,
    actor: ReturnActor
  ): Promise<{ returnId: string; orderId: string }> {
    if (returnId === null) {
      throw conflict(ErrorCodes.RETURN_ORDER_NOT_DELIVERED, 'the guide belongs to no return')
    }
    const done = await this.prisma.transaction(async tx => {
      const loaded = await this.lock(tx, storeId, returnId, true)
      this.assertMove(loaded.status, OrderReturnStatus.RECEIVED)
      // The guide is held until the end, as the shipment engine holds it for its own moves
      await tx.$queryRaw`SELECT id FROM shipments WHERE id = ${input.shipmentId} AND store_id = ${storeId} FOR UPDATE`
      const shipment = await tx.shipment.findFirst({
        where: { id: input.shipmentId, storeId, returnId, kind: ShipmentKind.RETURN },
        select: { id: true, status: true, connectionId: true }
      })
      if (shipment === null) throw resourceNotFound('shipment')
      const from = shipment.status as ShipmentStatus
      if (ShipmentInactiveStatuses.includes(from)) {
        throw conflict(
          ErrorCodes.RETURN_ORDER_NOT_DELIVERED,
          'the guide of the return is not one a package comes back by'
        )
      }
      const given = new Map((input.lines ?? []).map(line => [line.orderItemId, line]))
      for (const orderItemId of given.keys()) {
        if (!loaded.lines.some(line => line.orderItemId === orderItemId)) {
          throw invalid(
            'a line of the scan is not a line of the return',
            ErrorCodes.VALIDATION_INVALID_INPUT
          )
        }
      }
      // A package of a return holds the lines of that return: the scan chooses their condition and warehouse, not their units
      const receipt = await this.applyReceipt(
        tx,
        storeId,
        loaded,
        loaded.lines.map(line => {
          const chosen = given.get(line.orderItemId)
          return {
            orderItemId: line.orderItemId,
            condition: chosen?.condition ?? input.condition,
            ...(chosen?.restockWarehouseId === undefined
              ? {}
              : { restockWarehouseId: chosen.restockWarehouseId })
          }
        }),
        actor
      )
      loaded.status = OrderReturnStatus.RECEIVED
      // The package is at the warehouse: its guide says so with a manual event, when the table allows it from where it is (a
      // carrier that already said it, or a guide that has not left, stays as it is)
      if (isShipmentTransitionAllowed(from, ShipmentStatus.DELIVERED)) {
        await this.shipmentWrites.move(
          tx,
          {
            shipmentId: shipment.id,
            storeId,
            orderId: loaded.orderId,
            orderNumber: loaded.orderNumber,
            connectionId: shipment.connectionId
          },
          from,
          ShipmentStatus.DELIVERED,
          {},
          {
            actor: actorRef(actor),
            source: ShipmentEventSource.MANUAL,
            description: ShipmentEventNotes.RECEIVED_AT_WAREHOUSE
          }
        )
      }
      const settled = await this.settle(
        tx,
        storeId,
        loaded,
        input.refundAmountCents,
        undefined,
        actor
      )
      return { orderId: loaded.orderId, settled, receipt }
    })
    this.record(AuditAction.RETURN_RECEIVED_BY_SCAN, storeId, returnId, actor, {
      orderNumber: done.settled.orderNumber,
      shipmentId: input.shipmentId,
      reason: input.reason
    })
    this.recordOrderReturned(storeId, returnId, actor, done.receipt)
    this.recordPaymentRefunded(storeId, returnId, actor, done.settled)
    if (done.settled.refundCents !== null) {
      this.record(AuditAction.RETURN_REFUND_RECORDED, storeId, returnId, actor, {
        orderNumber: done.settled.orderNumber,
        refundAmountCents: done.settled.refundCents,
        paymentRefunded: done.settled.paymentRefunded
      })
    }
    return { returnId, orderId: done.orderId }
  }

  // ------------------------------------------------------------------------------------------ inside the transaction

  // The plain moves: the table of `OrderReturnStatusTransitions` decides, nothing else changes but the status and a note
  private async move(
    storeId: string,
    returnId: string,
    to: OrderReturnStatus,
    actor: ReturnActor,
    notes: string | null | undefined
  ): Promise<{ orderNumber: string }> {
    return this.prisma.transaction(async tx => {
      const loaded = await this.lock(tx, storeId, returnId, false)
      this.assertMove(loaded.status, to)
      await tx.orderReturn.update({
        where: { id: returnId },
        data: {
          status: to,
          ...(notes === undefined || notes === null
            ? {}
            : { notes: await this.withNote(tx, returnId, notes) })
        }
      })
      const payload = {
        storeId,
        orderId: loaded.orderId,
        orderNumber: loaded.orderNumber,
        returnId,
        actor: actorRef(actor)
      }
      if (to === OrderReturnStatus.APPROVED)
        this.events.publish(tx, Events.RETURN_APPROVED, payload)
      if (to === OrderReturnStatus.IN_TRANSIT) {
        this.events.publish(tx, Events.RETURN_IN_TRANSIT, payload)
      }
      return { orderNumber: loaded.orderNumber }
    })
  }

  // The store, the order and the return, locked in the order every writer of an order uses. `forStock` also takes the allocation
  // of the store, which every effect on stock takes before the levels.
  private async lock(
    tx: PrismaTransaction,
    storeId: string,
    returnId: string,
    forStock: boolean
  ): Promise<LoadedReturn> {
    const owner = await tx.orderReturn.findFirst({
      where: { id: returnId, storeId },
      select: { orderId: true }
    })
    if (owner === null) throw resourceNotFound('return')
    await lockStoreForWrite(tx, storeId)
    await this.orders.lockOrder(tx, storeId, owner.orderId)
    if (forStock) await lockStoreScope(tx, storeId, OrderLockScopes.ALLOCATION)
    await tx.$queryRaw`SELECT id FROM order_returns WHERE id = ${returnId} AND store_id = ${storeId} FOR UPDATE`
    const row = await tx.orderReturn.findFirst({
      where: { id: returnId, storeId },
      select: {
        id: true,
        orderId: true,
        type: true,
        status: true,
        order: { select: { orderNumber: true } },
        lines: { select: { id: true, orderItemId: true, quantity: true } }
      }
    })
    if (row === null) throw resourceNotFound('return')
    return {
      id: row.id,
      orderId: row.orderId,
      type: row.type as OrderReturnType,
      status: row.status as OrderReturnStatus,
      orderNumber: row.order.orderNumber,
      lines: row.lines
    }
  }

  private assertMove(from: OrderReturnStatus, to: OrderReturnStatus): void {
    if (!canMoveReturn(from, to)) {
      throw conflict(
        ErrorCodes.RETURN_INVALID_STATUS_TRANSITION,
        `a return cannot go from ${from} to ${to}`
      )
    }
  }

  private assertLines(
    items: readonly { id: string; quantity: number }[],
    held: ReadonlyMap<string, number>,
    lines: readonly { orderItemId: string; quantity: number }[]
  ): void {
    const verdict = checkReturnLines({ items, held, lines })
    if (verdict.ok) return
    if (verdict.code === ErrorCodes.RETURN_QUANTITY_EXCEEDS_DELIVERED) {
      throw conflict(verdict.code, 'more units than were delivered', {
        orderItemId: verdict.orderItemId
      })
    }
    throw invalid(
      'a line does not name an item of the order once, with a quantity',
      ErrorCodes.VALIDATION_INVALID_INPUT
    )
  }

  private async returnsOf(tx: PrismaTransaction, storeId: string, orderId: string) {
    const rows = await tx.orderReturn.findMany({
      where: { storeId, orderId },
      select: { status: true, lines: { select: { orderItemId: true, quantity: true } } }
    })
    return rows.map(row => ({ status: row.status as OrderReturnStatus, lines: row.lines }))
  }

  // The receipt of a return, in the transaction of the caller (which holds the store, the order, the allocation and the return):
  // the condition and the warehouse of each line, the stock by the condition, the status, and the order when everything is back.
  private async applyReceipt(
    tx: PrismaTransaction,
    storeId: string,
    loaded: LoadedReturn,
    chosen: readonly {
      orderItemId: string
      condition: OrderReturnCondition
      restockWarehouseId?: string | undefined
    }[],
    actor: ReturnActor
  ): Promise<{
    orderId: string
    orderNumber: string
    orderReturned: boolean
    orderFrom: OrderStatus | null
  }> {
    // Nothing is assumed resellable: the receipt names every line of the return, once
    const names = new Set(chosen.map(line => line.orderItemId))
    const wanted = new Set(loaded.lines.map(line => line.orderItemId))
    if (
      names.size !== chosen.length ||
      names.size !== wanted.size ||
      [...wanted].some(id => !names.has(id))
    ) {
      throw invalid(
        'the receipt must name every line of the return once',
        ErrorCodes.RETURN_RECEIPT_INVALID
      )
    }
    const items = await tx.orderItem.findMany({
      where: { id: { in: [...wanted] }, orderId: loaded.orderId },
      select: {
        id: true,
        productId: true,
        variantId: true,
        product: { select: { trackInventory: true } },
        allocations: { select: { warehouseId: true, quantity: true } }
      }
    })
    const itemOf = new Map(items.map(item => [item.id, item]))
    const movements: MovementInput[] = []
    const warehouseOf = new Map<string, string | null>()
    for (const line of loaded.lines) {
      const choice = chosen.find(entry => entry.orderItemId === line.orderItemId)
      const item = itemOf.get(line.orderItemId)
      if (choice === undefined || item === undefined) {
        throw invalid(
          'the receipt names a line that is not of the return',
          ErrorCodes.RETURN_RECEIPT_INVALID
        )
      }
      if (!item.product.trackInventory) {
        warehouseOf.set(line.orderItemId, null)
        continue
      }
      const warehouseId = choice.restockWarehouseId ?? defaultRestockWarehouse(item.allocations)
      if (warehouseId === null) {
        throw invalid('a warehouse is needed for the units', ErrorCodes.RETURN_RECEIPT_INVALID)
      }
      // A unit that is discarded at once only passes through the warehouse: a warehouse that was switched off or unlinked since
      // does not stop its receipt unless the person chose it
      if (
        choice.condition === OrderReturnCondition.RESELLABLE ||
        choice.restockWarehouseId !== undefined
      ) {
        await this.assertWarehouse(tx, storeId, warehouseId)
      }
      warehouseOf.set(line.orderItemId, warehouseId)
      for (const step of movementsOfReceipt(choice.condition)) {
        movements.push({
          storeId,
          productId: item.productId,
          variantId: item.variantId,
          warehouseId,
          type: step.type,
          quantity: line.quantity,
          idempotencyKey: returnMovementKey(loaded.id, line.orderItemId, step.movement),
          reason: step.reason,
          reference: { type: InventoryReferenceType.RETURN, id: loaded.id },
          createdBy: actor.userId
        })
      }
    }
    if (movements.length > 0) await this.inventory.moveMany(movements, tx)
    for (const line of loaded.lines) {
      const choice = chosen.find(entry => entry.orderItemId === line.orderItemId)
      await tx.orderReturnLine.update({
        where: { id: line.id },
        data: {
          condition: choice?.condition ?? null,
          restockWarehouseId: warehouseOf.get(line.orderItemId) ?? null
        }
      })
    }
    await tx.orderReturn.update({
      where: { id: loaded.id },
      data: { status: OrderReturnStatus.RECEIVED, receivedAt: new Date() }
    })
    this.events.publish(tx, Events.RETURN_RECEIVED, {
      storeId,
      orderId: loaded.orderId,
      orderNumber: loaded.orderNumber,
      returnId: loaded.id,
      actor: actorRef(actor)
    })
    // The order is returned when what is back covers every unit of every item; a part leaves it as it was
    const order = await tx.order.findFirstOrThrow({
      where: { id: loaded.orderId, storeId },
      select: { items: { select: { id: true, quantity: true } } }
    })
    const all = await this.returnsOf(tx, storeId, loaded.orderId)
    let orderFrom: OrderStatus | null = null
    if (coversEveryUnit(order.items, all)) {
      orderFrom =
        (await this.orders.markReturned(tx, storeId, loaded.orderId, actorRef(actor)))?.from ?? null
    }
    return {
      orderId: loaded.orderId,
      orderNumber: loaded.orderNumber,
      orderReturned: orderFrom !== null,
      orderFrom
    }
  }

  // Completing: the refund by hand (a refund return only) and the payment it settles
  private async settle(
    tx: PrismaTransaction,
    storeId: string,
    loaded: LoadedReturn,
    refundCents: number | undefined,
    notes: string | undefined,
    actor: ReturnActor
  ): Promise<{
    orderId: string
    orderNumber: string
    refundCents: number | null
    paymentRefunded: boolean
  }> {
    let paymentRefunded = false
    if (loaded.type === OrderReturnType.EXCHANGE && refundCents !== undefined) {
      // An exchange refunds only what its credit left over (a replacement that costs less than what came back), by hand, and
      // never moves the payment of the returned order to REFUNDED: the customer keeps the goods of the replacement
      const room = await this.exchangeRefundRoom(tx, storeId, loaded)
      if (refundCents > room) {
        throw conflict(
          ErrorCodes.RETURN_REFUND_EXCEEDS_PAID,
          'the refund is more than the credit left over',
          { roomCents: room }
        )
      }
    } else if (refundCents !== undefined) {
      const order = await tx.order.findFirstOrThrow({
        where: { id: loaded.orderId, storeId },
        select: { totalCents: true, paymentStatus: true }
      })
      const others = await tx.orderReturn.aggregate({
        where: {
          storeId,
          orderId: loaded.orderId,
          id: { not: loaded.id },
          status: OrderReturnStatus.COMPLETED
        },
        _sum: { refundAmountCents: true }
      })
      const already = others._sum.refundAmountCents ?? 0
      // Money that was never collected is not given back: only a payment that was completed has anything to refund
      const room =
        (order.paymentStatus as PaymentStatus) === PaymentStatus.COMPLETED
          ? refundRoom({ orderTotalCents: order.totalCents, alreadyRefundedCents: already })
          : 0
      if (refundCents > room) {
        throw conflict(
          ErrorCodes.RETURN_REFUND_EXCEEDS_PAID,
          'the refund is more than the customer paid',
          {
            roomCents: room
          }
        )
      }
      if (already + refundCents >= order.totalCents && order.totalCents > 0) {
        paymentRefunded = await this.orders.markRefunded(
          tx,
          storeId,
          loaded.orderId,
          actorRef(actor)
        )
      }
    }
    await tx.orderReturn.update({
      where: { id: loaded.id },
      data: {
        status: OrderReturnStatus.COMPLETED,
        ...(refundCents === undefined ? {} : { refundAmountCents: refundCents }),
        ...(notes === undefined ? {} : { notes: await this.withNote(tx, loaded.id, notes) })
      }
    })
    return {
      orderId: loaded.orderId,
      orderNumber: loaded.orderNumber,
      refundCents: refundCents ?? null,
      paymentRefunded
    }
  }

  // What the returned lines are worth to the customer (`exchangeCreditCents`): read from the order the return is of, which the caller
  // holds locked. A line whose item is gone is a broken return, never a credit of zero.
  private async exchangeCredit(tx: PrismaTransaction, loaded: LoadedReturn): Promise<number> {
    const order = await tx.order.findFirstOrThrow({
      where: { id: loaded.orderId },
      select: {
        subtotalCents: true,
        discountCents: true,
        items: { select: { id: true, unitPriceCents: true } }
      }
    })
    const priceOf = new Map(order.items.map(item => [item.id, item.unitPriceCents]))
    return exchangeCreditCents(
      loaded.lines.map(line => {
        const unitPriceCents = priceOf.get(line.orderItemId)
        if (unitPriceCents === undefined) {
          throw invalid(
            'a line of the return names an item that the order does not have',
            ErrorCodes.VALIDATION_INVALID_INPUT
          )
        }
        return { unitPriceCents, quantity: line.quantity }
      }),
      order
    )
  }

  // The credit of an exchange minus what its replacement took of it, less the refunds of the other returns of the order: what the
  // owner may still settle by hand. Money that was never collected is not given back.
  private async exchangeRefundRoom(
    tx: PrismaTransaction,
    storeId: string,
    loaded: LoadedReturn
  ): Promise<number> {
    const row = await tx.orderReturn.findFirstOrThrow({
      where: { id: loaded.id, storeId },
      select: {
        order: { select: { paymentStatus: true } },
        replacementOrder: { select: { discountCents: true } }
      }
    })
    if ((row.order.paymentStatus as PaymentStatus) !== PaymentStatus.COMPLETED) return 0
    const credit = await this.exchangeCredit(tx, loaded)
    return Math.max(0, credit - (row.replacementOrder?.discountCents ?? 0))
  }

  // A decision's note is added to the note of the request, never in place of it: what the agent saw stays with the return
  private async withNote(tx: PrismaTransaction, returnId: string, note: string): Promise<string> {
    const row = await tx.orderReturn.findUniqueOrThrow({
      where: { id: returnId },
      select: { notes: true }
    })
    return row.notes === null || row.notes === '' ? note : `${row.notes}\n${note}`
  }

  private async assertWarehouse(
    tx: PrismaTransaction,
    storeId: string,
    warehouseId: string
  ): Promise<void> {
    const link = await tx.storeWarehouse.findFirst({
      where: { storeId, warehouseId },
      select: { warehouse: { select: { active: true } } }
    })
    if (link === null) throw warehouseNotLinked(warehouseId)
    if (!link.warehouse.active) throw warehouseInactive(warehouseId)
  }

  // The order changed because of a return: its own trail says so, as it does for a status set by hand
  private recordOrderReturned(
    storeId: string,
    returnId: string,
    actor: ReturnActor,
    receipt: { orderId: string; orderNumber: string; orderFrom: OrderStatus | null }
  ): void {
    if (receipt.orderFrom === null) return
    this.audit.log({
      action: AuditAction.ORDER_STATUS_CHANGED,
      actor: { userId: actor.userId },
      storeId,
      resourceType: OrderResourceTypes.ORDER,
      resourceId: receipt.orderId,
      metadata: {
        orderNumber: receipt.orderNumber,
        from: receipt.orderFrom,
        to: OrderStatus.RETURNED,
        returnId
      },
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent
    })
  }

  private recordPaymentRefunded(
    storeId: string,
    returnId: string,
    actor: ReturnActor,
    settled: { orderId: string; orderNumber: string; paymentRefunded: boolean }
  ): void {
    if (!settled.paymentRefunded) return
    this.audit.log({
      action: AuditAction.ORDER_PAYMENT_STATUS_CHANGED,
      actor: { userId: actor.userId },
      storeId,
      resourceType: OrderResourceTypes.ORDER,
      resourceId: settled.orderId,
      metadata: {
        orderNumber: settled.orderNumber,
        from: PaymentStatus.COMPLETED,
        to: PaymentStatus.REFUNDED,
        returnId
      },
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent
    })
  }

  private record(
    action: AuditActionType,
    storeId: string,
    returnId: string,
    actor: ReturnActor,
    metadata: Record<string, unknown>
  ): void {
    this.audit.log({
      action,
      actor: { userId: actor.userId },
      storeId,
      resourceType: ReturnResourceTypes.RETURN,
      resourceId: returnId,
      metadata,
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent
    })
  }
}
