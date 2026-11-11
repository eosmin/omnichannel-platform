import { randomUUID } from 'node:crypto'

import { Injectable } from '@nestjs/common'

import { AuditAction } from '@platform/core/audit'
import { AuditService } from '@platform/core/audit-module'
import { type Permission, Permissions } from '@platform/core/auth'
import {
  DatabaseNull,
  type OrderUncheckedUpdateInput,
  lockStoreForWrite,
  lockStoreScope,
  PrismaService,
  type PrismaTransaction
} from '@platform/core/database'
import {
  calendarDayToDate,
  CarrierConnectionStatus,
  checkOrderEdit,
  editableOrderFields,
  lockedOrderFields,
  isPriceApprovalBlocking,
  nextCalendarDay,
  normalizeNote,
  OrderConfirmationChannel,
  OrderLockScopes,
  OrderNotices,
  OrderListFilters,
  OrderScheduleFilters,
  OrderSummaryEvents,
  OrderSorts,
  OrderStatus,
  orderFieldsOfEdit,
  PaymentStatus,
  PriceApprovalStatus,
  scheduledDeliveryShortcutRange,
  shouldWarnWarehouseOfPackingNote,
  startOfCalendarDayIn,
  type CreateOrderInput,
  type UpdateOrderInput
} from '@platform/core/domain'
import { ErrorCodes, resourceNotFound } from '@platform/core/errors'
import { DomainEvents } from '@platform/core/event-bus'
import { Events } from '@platform/core/events'
import {
  orderListWhere,
  type ResolvedOrderFilters,
  writeOrderSummaryLine
} from '@platform/core/messaging'
import { ExportFormats, ExportTypes } from '@platform/core/queues'
import { readOrderPreferences } from '@platform/core/store-preferences'

import { ExportsService, type ExportView } from '../exports'
import type { Actor } from '../tenancy'

import { type LineToAllocate, OrderInventoryService } from './orders-inventory.service'
import {
  approvalColumnsCleared,
  planCarrier,
  priceOrder,
  resolveLines,
  type OrderLine
} from './orders-pricing'
import { type ListOrdersQuery, encodeOrderCursor } from './orders.schemas'
import {
  actorRef,
  assertHolds,
  hasActiveGuide,
  lockOrder,
  mayReadOrders,
  orderRefusal,
  recordOrderAudit,
  resolveCustomerForOrder,
  takeOrderNumber
} from './orders.support'
import {
  detailView,
  ORDER_DETAIL_SELECT,
  ORDER_LIST_SELECT,
  summaryView,
  type OrderDetailView,
  type OrderPage
} from './orders.views'

// The lines of an order as the stock sees them: each with the id of the row that was made for it
function toAllocatable(lines: readonly OrderLine[], itemIds: readonly string[]): LineToAllocate[] {
  return lines.map((line, index) => ({
    itemId: itemIds[index] as string,
    productId: line.productId,
    variantId: line.variantId,
    quantity: line.quantity,
    trackInventory: line.trackInventory,
    requested: line.requestedAllocations,
    preferred: line.preferredAllocations
  }))
}

// What the list and the export take: the query without its page and its sort
export type OrderFilters = Omit<ListOrdersQuery, 'cursor' | 'limit' | typeof OrderListFilters.SORT>

export interface ResolvedListFilters {
  where: ResolvedOrderFilters
  // Inclusive days of the scheduled delivery, null for no bound
  scheduled: { from: string | null; to: string | null }
}

export interface CreatedOrder {
  order: OrderDetailView
  // What the server did not do that the request asked for, by a constant of OrderNotices
  notices: string[]
}

// The orders of the store of the request. Every query is filtered by that store (TenantGuard) and the store is never
// read from the body or the query string. The prices and the totals are computed here, never taken from the client.
// The changes of status and the decisions on a price are in OrdersStatusService.
@Injectable()
export class OrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    private readonly stock: OrderInventoryService,
    private readonly exports: ExportsService
  ) {}

  // The filters of the list as the database reads them. Every day is a day on the clock of the store, not of the server
  // (decision D18): the store is read only when a filter names a day or a shortcut. The export freezes this result in its
  // row, so the file holds what the list showed.
  async resolveFilters(storeId: string, filters: OrderFilters): Promise<ResolvedListFilters> {
    const shortcut = filters[OrderScheduleFilters.ON]
    const createdFrom = filters[OrderListFilters.CREATED_FROM]
    const createdTo = filters[OrderListFilters.CREATED_TO]
    const needsClock =
      shortcut !== undefined || createdFrom !== undefined || createdTo !== undefined
    const store = needsClock
      ? await this.prisma.client.store.findUnique({
          where: { id: storeId },
          select: { timezone: true }
        })
      : null
    if (needsClock && store === null) throw resourceNotFound('store')
    const timezone = store?.timezone ?? ''
    const range =
      shortcut === undefined
        ? {
            from: filters[OrderScheduleFilters.FROM] ?? null,
            to: filters[OrderScheduleFilters.TO] ?? null
          }
        : scheduledDeliveryShortcutRange(shortcut, timezone, new Date())
    return {
      where: {
        q: filters[OrderListFilters.Q],
        status: filters[OrderListFilters.STATUS],
        paymentStatus: filters[OrderListFilters.PAYMENT_STATUS],
        priceApprovalStatus: filters[OrderListFilters.PRICE_APPROVAL_STATUS],
        customerId: filters[OrderListFilters.CUSTOMER_ID],
        createdFrom:
          createdFrom === undefined ? undefined : startOfCalendarDayIn(timezone, createdFrom),
        // The day after the last one starts where the last one ends
        createdBefore:
          createdTo === undefined
            ? undefined
            : startOfCalendarDayIn(timezone, nextCalendarDay(createdTo))
      },
      scheduled: range
    }
  }

  // The CSV of the orders the list shows with these filters. The days are resolved now, on the clock of the store, so the
  // file made later holds what the screen showed; the caller has checked orders:view and orders:export.
  async requestExport(storeId: string, userId: string, filters: OrderFilters): Promise<ExportView> {
    const { where, scheduled } = await this.resolveFilters(storeId, filters)
    return this.exports.request({
      storeId,
      userId,
      type: ExportTypes.ORDERS,
      format: ExportFormats.CSV,
      filters: {
        ...(where.q === undefined ? {} : { q: where.q }),
        ...(where.status === undefined ? {} : { status: where.status }),
        ...(where.paymentStatus === undefined ? {} : { paymentStatus: where.paymentStatus }),
        ...(where.priceApprovalStatus === undefined
          ? {}
          : { priceApprovalStatus: where.priceApprovalStatus }),
        ...(where.customerId === undefined ? {} : { customerId: where.customerId }),
        ...(where.createdFrom === undefined
          ? {}
          : { createdFrom: where.createdFrom.toISOString() }),
        ...(where.createdBefore === undefined
          ? {}
          : { createdBefore: where.createdBefore.toISOString() }),
        ...(scheduled.from === null ? {} : { scheduledDeliveryFrom: scheduled.from }),
        ...(scheduled.to === null ? {} : { scheduledDeliveryTo: scheduled.to })
      }
    })
  }

  async list(storeId: string, query: ListOrdersQuery): Promise<OrderPage> {
    const { where: resolved, scheduled: range } = await this.resolveFilters(storeId, query)
    const bySchedule = query[OrderListFilters.SORT] === OrderSorts.SCHEDULED_DELIVERY
    const { cursor } = query
    const after = (position: { createdAt: Date; id: string }) => [
      { createdAt: { lt: position.createdAt } },
      { createdAt: position.createdAt, id: { lt: position.id } }
    ]
    const rows = await this.prisma.client.order.findMany({
      where: {
        ...orderListWhere(storeId, resolved),
        ...(range.from === null && range.to === null
          ? {}
          : {
              scheduledDeliveryDate: {
                ...(range.from === null ? {} : { gte: calendarDayToDate(range.from) }),
                ...(range.to === null ? {} : { lte: calendarDayToDate(range.to) })
              }
            }),
        ...(cursor === undefined
          ? {}
          : bySchedule
            ? // Soonest day first with the orders that have none last: after a day, the later days, the same day
              // further down, and every order with no day
              cursor.day === null
              ? { scheduledDeliveryDate: null, OR: after(cursor) }
              : {
                  OR: [
                    { scheduledDeliveryDate: { gt: calendarDayToDate(cursor.day) } },
                    { scheduledDeliveryDate: calendarDayToDate(cursor.day), OR: after(cursor) },
                    { scheduledDeliveryDate: null }
                  ]
                }
            : { OR: after(cursor) })
      },
      select: ORDER_LIST_SELECT,
      take: query.limit + 1,
      orderBy: bySchedule
        ? [
            { scheduledDeliveryDate: { sort: 'asc', nulls: 'last' } },
            { createdAt: 'desc' },
            { id: 'desc' }
          ]
        : [{ createdAt: 'desc' }, { id: 'desc' }]
    })
    const hasMore = rows.length > query.limit
    const page = hasMore ? rows.slice(0, query.limit) : rows
    const last = page.at(-1)
    return {
      data: page.map(summaryView),
      nextCursor:
        hasMore && last !== undefined
          ? encodeOrderCursor({
              day:
                bySchedule && last.scheduledDeliveryDate !== null
                  ? last.scheduledDeliveryDate.toISOString().slice(0, 10)
                  : null,
              createdAt: last.createdAt,
              id: last.id
            })
          : null,
      hasMore
    }
  }

  async get(
    storeId: string,
    orderId: string,
    held: readonly Permission[]
  ): Promise<OrderDetailView> {
    const row = await this.prisma.client.order.findFirst({
      where: { id: orderId, storeId },
      select: ORDER_DETAIL_SELECT
    })
    if (row === null) throw resourceNotFound('order')
    const view = detailView(row, mayReadOrders(held))
    // The warehouses of a split line in the order the store reserves them (priority 1 first): the rows of one statement
    // share their creation moment, so the database order would be arbitrary
    if (view.items.some(item => item.allocations.length > 1)) {
      const links = await this.prisma.client.storeWarehouse.findMany({
        where: { storeId },
        select: { warehouseId: true, priority: true }
      })
      const priority = new Map(links.map(link => [link.warehouseId, link.priority]))
      for (const item of view.items) {
        item.allocations.sort(
          (a, b) =>
            (priority.get(a.warehouseId) ?? Number.MAX_SAFE_INTEGER) -
            (priority.get(b.warehouseId) ?? Number.MAX_SAFE_INTEGER)
        )
      }
    }
    return view
  }

  async create(
    storeId: string,
    body: CreateOrderInput,
    actor: Actor,
    held: readonly Permission[]
  ): Promise<CreatedOrder> {
    // Confirming at creation is for who may confirm: the server refuses the flag from anybody else, it does not ignore it
    if (body.confirmOnCreate) assertHolds(held, Permissions.ORDERS_CONFIRM)
    // The thread of a conversation gets a line of the order: the member must be able to see the inbox
    if (body.conversationId !== undefined) assertHolds(held, Permissions.CONVERSATIONS_VIEW)
    const canOverridePrice = held.includes(Permissions.ORDERS_OVERRIDE_PRICE)

    const created = await this.prisma.transaction(async tx => {
      await lockStoreForWrite(tx, storeId)
      const customerId = await resolveCustomerForOrder(tx, storeId, body.customerId)
      if (body.conversationId !== undefined) {
        const conversation = await tx.conversation.findFirst({
          where: { id: body.conversationId, storeId },
          select: { customerId: true }
        })
        // The thread of another customer is not this order's thread (the customer asked for, or the survivor of a merge)
        if (
          conversation === null ||
          (conversation.customerId !== customerId && conversation.customerId !== body.customerId)
        ) {
          throw resourceNotFound('conversation')
        }
      }
      const store = await tx.store.findUniqueOrThrow({
        where: { id: storeId },
        select: { currency: true, settings: { select: { preferences: true } } }
      })
      const { lines, priceChanged } = await resolveLines(tx, storeId, body.items, {
        userId: actor.userId,
        canOverridePrice
      })
      const planned = await planCarrier(tx, storeId, body.carrierConnectionId, true)
      const { totals, freeShipping, control } = priceOrder({
        feeBounds: planned.bounds,
        lines,
        shippingCents: body.shippingCents,
        discountCents: body.discountCents,
        discountReason: body.discountReason,
        linePriceChanged: priceChanged,
        canOverridePrice,
        preferences: readOrderPreferences(store.settings?.preferences),
        approvalStatus: PriceApprovalStatus.NOT_REQUIRED,
        approved: null
      })

      // An order whose price is waiting for an approval is never confirmed, with or without the checkbox: it is made
      // pending and the answer says so (TDD_17 §4.3)
      const notices: string[] = []
      let confirmNow = body.confirmOnCreate
      if (confirmNow && isPriceApprovalBlocking(control.approvalStatus)) {
        confirmNow = false
        notices.push(OrderNotices.CONFIRMATION_SKIPPED_PRICE_APPROVAL)
      }
      const now = new Date()
      const status = confirmNow ? OrderStatus.CONFIRMED : OrderStatus.PENDING_CONFIRMATION
      const order = await tx.order.create({
        data: {
          storeId,
          customerId,
          ...(body.conversationId === undefined ? {} : { conversationId: body.conversationId }),
          orderNumber: await takeOrderNumber(tx, storeId),
          status,
          subtotalCents: totals.subtotalCents,
          shippingCents: totals.shippingCents,
          discountCents: totals.discountCents,
          totalCents: totals.totalCents,
          carrierConnectionId: planned.connectionId,
          currency: store.currency,
          paymentMethod: body.paymentMethod,
          ...(body.shippingAddress === undefined ? {} : { shippingAddress: body.shippingAddress }),
          recipientPhones: body.recipientPhones,
          customerNotes: normalizeNote(body.customerNotes),
          internalNotes: normalizeNote(body.internalNotes),
          packingNotes: normalizeNote(body.packingNotes),
          scheduledDeliveryDate:
            body.scheduledDeliveryDate === null
              ? null
              : calendarDayToDate(body.scheduledDeliveryDate),
          freeShipping,
          discountReason: normalizeNote(body.discountReason),
          priceApprovalStatus: control.approvalStatus,
          priceApprovalRequestedBy:
            control.approvalStatus === PriceApprovalStatus.PENDING ? actor.userId : null,
          ...(confirmNow
            ? {
                confirmedAt: now,
                confirmedBy: actor.userId,
                confirmedVia: OrderConfirmationChannel.AT_CREATION
              }
            : {}),
          createdBy: actor.userId
        },
        select: { id: true, orderNumber: true }
      })
      const itemIds = await this.writeLines(tx, order.id, lines)
      await this.stock.allocateAndReserve(tx, {
        storeId,
        orderId: order.id,
        lines: toAllocatable(lines, itemIds),
        createdBy: actor.userId
      })

      // The thread of the conversation the order came from says so, in the same transaction
      if (body.conversationId !== undefined) {
        await writeOrderSummaryLine(tx, storeId, body.conversationId, {
          event: OrderSummaryEvents.CREATED,
          orderId: order.id,
          orderNumber: order.orderNumber,
          status,
          totalCents: totals.totalCents,
          currency: store.currency,
          itemCount: lines.length,
          actor: actorRef(actor)
        })
      }

      const common = {
        storeId,
        orderId: order.id,
        orderNumber: order.orderNumber,
        actor: actorRef(actor)
      }
      this.events.publish(tx, Events.ORDER_CREATED, {
        ...common,
        customerId,
        conversationId: body.conversationId ?? null,
        totalCents: totals.totalCents,
        currency: store.currency
      })
      if (confirmNow) this.events.publish(tx, Events.ORDER_CONFIRMED, common)
      if (control.overridden) this.events.publish(tx, Events.ORDER_PRICE_OVERRIDDEN, common)
      if (control.approvalStatus === PriceApprovalStatus.PENDING) {
        this.events.publish(tx, Events.ORDER_PRICE_APPROVAL_REQUESTED, common)
      }
      return { order, totals, control, confirmNow, status, lines, customerId, notices }
    })

    const trail = { storeId, orderId: created.order.id, actor }
    recordOrderAudit(this.audit, AuditAction.ORDER_CREATED, trail, {
      orderNumber: created.order.orderNumber,
      status: created.status,
      customerId: created.customerId,
      totalCents: created.totals.totalCents,
      items: created.lines.length
    })
    if (created.confirmNow) {
      recordOrderAudit(this.audit, AuditAction.ORDER_CONFIRMED, trail, {
        via: OrderConfirmationChannel.AT_CREATION
      })
    }
    if (created.totals.discountCents > 0) {
      recordOrderAudit(this.audit, AuditAction.ORDER_DISCOUNT_APPLIED, trail, {
        discountCents: created.totals.discountCents,
        subtotalCents: created.totals.subtotalCents,
        reason: normalizeNote(body.discountReason)
      })
    }
    if (created.control.overridden) {
      recordOrderAudit(
        this.audit,
        AuditAction.ORDER_PRICE_OVERRIDDEN,
        trail,
        this.overrideTrail(created.lines)
      )
    }
    if (created.control.approvalStatus === PriceApprovalStatus.PENDING) {
      recordOrderAudit(this.audit, AuditAction.ORDER_PRICE_APPROVAL_REQUESTED, trail, {
        discountCents: created.totals.discountCents,
        shippingCents: created.totals.shippingCents
      })
    }
    return { order: await this.get(storeId, created.order.id, held), notices: created.notices }
  }

  async update(
    storeId: string,
    orderId: string,
    body: UpdateOrderInput,
    actor: Actor,
    held: readonly Permission[]
  ): Promise<OrderDetailView> {
    const canOverridePrice = held.includes(Permissions.ORDERS_OVERRIDE_PRICE)
    const outcome = await this.prisma.transaction(async tx => {
      await lockStoreForWrite(tx, storeId)
      await lockOrder(tx, storeId, orderId)
      const order = await tx.order.findFirstOrThrow({
        where: { id: orderId, storeId },
        include: { items: true, store: { select: { settings: { select: { preferences: true } } } } }
      })
      const status = order.status as OrderStatus

      // With a guide the tracking number is the guide's, not the agent's (TDD_17 §4.5 step 4)
      const hasActiveShipment = await hasActiveGuide(tx, storeId, orderId)
      const requested = orderFieldsOfEdit(body)
      const verdict = checkOrderEdit(status, requested, { hasActiveShipment })
      if (!verdict.ok) {
        throw orderRefusal(verdict.code, {
          fields: lockedOrderFields(status, requested, { hasActiveShipment })
        })
      }

      // The way an order was sold is fixed once a payment moved: a cash-on-delivery order must not be turned into a transfer,
      // paid before it is delivered and turned back (the cash-on-delivery rule reads this field)
      if (
        body.paymentMethod !== undefined &&
        (order.paymentStatus as PaymentStatus) !== PaymentStatus.PENDING
      ) {
        throw orderRefusal(ErrorCodes.ORDER_FIELD_NOT_EDITABLE, { fields: ['paymentMethod'] })
      }
      // The money that was recorded is for the total it was recorded against: once a payment is COMPLETED the lines, the
      // fee and the discount are fixed (refund it and the order is open again). No amount is stored with a payment.
      if (
        (order.paymentStatus as PaymentStatus) === PaymentStatus.COMPLETED &&
        (body.items !== undefined ||
          body.shippingCents !== undefined ||
          body.carrierConnectionId !== undefined ||
          body.discountCents !== undefined ||
          body.discountReason !== undefined)
      ) {
        throw orderRefusal(ErrorCodes.ORDER_FIELD_NOT_EDITABLE, {
          fields: ['items', 'shipping', 'discount'].filter(field =>
            field === 'items'
              ? body.items !== undefined
              : field === 'shipping'
                ? body.shippingCents !== undefined || body.carrierConnectionId !== undefined
                : body.discountCents !== undefined || body.discountReason !== undefined
          )
        })
      }
      // The reason belongs to the discount: where the status locks the discount it is not rewritten, unless there is no
      // discount and the reason is the one of a fee
      if (
        body.discountReason !== undefined &&
        order.discountCents > 0 &&
        !editableOrderFields(status, { hasActiveShipment }).includes('discount')
      ) {
        throw orderRefusal(ErrorCodes.ORDER_FIELD_NOT_EDITABLE, { fields: ['discount'] })
      }

      // The price: when any of its four parts is in the request the whole order is priced again, the others as stored
      const carrierChanged =
        body.carrierConnectionId !== undefined &&
        body.carrierConnectionId !== order.carrierConnectionId
      const repricing =
        carrierChanged ||
        body.items !== undefined ||
        body.shippingCents !== undefined ||
        body.discountCents !== undefined ||
        body.discountReason !== undefined
      const data: OrderUncheckedUpdateInput = {}
      let lines: OrderLine[] | null = null
      let overridden = false
      let becamePending = false
      let withdrewRequest = false
      // A request that was already open and was moved by this edit: the approvers are told again
      let reRequested = false
      let discountChanged = false
      if (repricing) {
        const current: OrderLine[] = order.items.map(item => ({
          productId: item.productId,
          variantId: item.variantId,
          productName: item.productName,
          variantName: item.variantName,
          quantity: item.quantity,
          unitPriceCents: item.unitPriceCents,
          originalUnitPriceCents: item.originalUnitPriceCents,
          priceOverrideReason: item.priceOverrideReason,
          priceOverriddenBy: item.priceOverriddenBy,
          freeShipping: item.freeShipping,
          trackInventory: true
        }))
        let priceChanged = false
        if (body.items !== undefined) {
          const resolved = await resolveLines(tx, storeId, body.items, {
            userId: actor.userId,
            canOverridePrice,
            existing: current
          })
          // A line the edit did not touch (same product, variant and units) keeps the warehouses it had, when they can still
          // serve it: an edit of another line must not move this one's stock
          const placed = await tx.orderItemAllocation.findMany({
            where: { storeId, orderItem: { orderId } },
            select: {
              warehouseId: true,
              quantity: true,
              orderItem: { select: { productId: true, variantId: true, quantity: true } }
            }
          })
          lines = resolved.lines.map(line => {
            if (line.requestedAllocations !== undefined) return line
            const same = placed.filter(
              row =>
                row.orderItem.productId === line.productId &&
                row.orderItem.variantId === line.variantId &&
                row.orderItem.quantity === line.quantity
            )
            return same.length === 0
              ? line
              : {
                  ...line,
                  preferredAllocations: same.map(row => ({
                    warehouseId: row.warehouseId,
                    quantity: row.quantity
                  }))
                }
          })
          priceChanged = resolved.priceChanged
        }
        const shippingCents = body.shippingCents ?? order.shippingCents
        const discountCents = body.discountCents ?? order.discountCents
        const discountReason =
          body.discountReason === undefined ? order.discountReason : body.discountReason
        const before = order.priceApprovalStatus as PriceApprovalStatus
        // The carrier the fee is judged against: the new one, or the one the order has while it is still a live connection
        // (a carrier that was disconnected since is no carrier: the order is judged as one with none)
        const keptCarrier =
          order.carrierConnectionId !== null &&
          (await tx.carrierConnection.count({
            where: {
              id: order.carrierConnectionId,
              storeId,
              status: CarrierConnectionStatus.ACTIVE
            }
          })) > 0
            ? order.carrierConnectionId
            : null
        const planned = await planCarrier(
          tx,
          storeId,
          carrierChanged ? body.carrierConnectionId : keptCarrier,
          false
        )
        const pricing = priceOrder({
          feeBounds: planned.bounds,
          lines: lines ?? current,
          shippingCents,
          discountCents,
          discountReason,
          linePriceChanged: priceChanged,
          canOverridePrice,
          preferences: readOrderPreferences(order.store.settings?.preferences),
          approvalStatus: before,
          // An approval is for the lines it was given on: other lines are another order for the approver
          approved:
            body.items !== undefined
              ? null
              : {
                  discountCents: order.priceApprovedDiscountCents,
                  shippingCents: order.priceApprovedShippingCents
                },
          // What the order already had, on the same lines, is not put to the test again by an edit of something else
          discountUnchanged: body.items === undefined && discountCents === order.discountCents,
          feeUnchanged:
            body.items === undefined && !carrierChanged && shippingCents === order.shippingCents
        })
        // Only a price this edit really moved is an override of this edit: the rest of the order may carry an old one
        const priceMoved =
          priceChanged ||
          discountCents !== order.discountCents ||
          shippingCents !== order.shippingCents
        // What an approver would be approving also changes with the lines and with the reason: whoever changes either of
        // them is who asks for the approval
        const priceTouched =
          priceMoved || body.items !== undefined || discountReason !== order.discountReason
        overridden = pricing.control.overridden && priceMoved
        withdrewRequest = pricing.control.withdrawsRequest
        reRequested =
          pricing.control.approvalStatus === PriceApprovalStatus.PENDING &&
          before === PriceApprovalStatus.PENDING &&
          priceTouched
        discountChanged = discountCents !== order.discountCents && discountCents > 0
        const next = pricing.control.approvalStatus
        becamePending =
          next === PriceApprovalStatus.PENDING && before !== PriceApprovalStatus.PENDING
        Object.assign(data, {
          subtotalCents: pricing.totals.subtotalCents,
          shippingCents: pricing.totals.shippingCents,
          discountCents: pricing.totals.discountCents,
          totalCents: pricing.totals.totalCents,
          freeShipping: pricing.freeShipping,
          discountReason: normalizeNote(discountReason),
          priceApprovalStatus: next,
          ...(carrierChanged ? { carrierConnectionId: planned.connectionId } : {})
        })
        if (next === PriceApprovalStatus.NOT_REQUIRED) {
          Object.assign(data, { priceApprovalRequestedBy: null, ...approvalColumnsCleared })
        } else if (next === PriceApprovalStatus.PENDING) {
          // The old approval named other values: it is spent. The one who asks is who made the change that needs it.
          Object.assign(data, {
            // Whoever moved the price is who asks for its approval, so nobody approves a price they set
            priceApprovalRequestedBy:
              becamePending || priceTouched ? actor.userId : order.priceApprovalRequestedBy,
            ...approvalColumnsCleared
          })
        }
      }

      if (lines !== null) {
        // Same order of locks as a creation: the order, then the allocation of the store, then the levels
        await lockStoreScope(tx, storeId, OrderLockScopes.ALLOCATION)
        await this.stock.release(tx, storeId, orderId, actor.userId)
        await tx.orderItem.deleteMany({ where: { orderId, order: { storeId } } })
        const itemIds = await this.writeLines(tx, orderId, lines)
        await this.stock.allocateAndReserve(tx, {
          storeId,
          orderId,
          lines: toAllocatable(lines, itemIds),
          createdBy: actor.userId
        })
      }

      if (body.shippingAddress !== undefined) {
        data.shippingAddress = body.shippingAddress === null ? DatabaseNull : body.shippingAddress
      }
      if (body.recipientPhones !== undefined) data.recipientPhones = body.recipientPhones
      if (body.scheduledDeliveryDate !== undefined) {
        data.scheduledDeliveryDate =
          body.scheduledDeliveryDate === null ? null : calendarDayToDate(body.scheduledDeliveryDate)
      }
      if (body.paymentMethod !== undefined) data.paymentMethod = body.paymentMethod
      if (body.customerNotes !== undefined) data.customerNotes = normalizeNote(body.customerNotes)
      if (body.internalNotes !== undefined) data.internalNotes = normalizeNote(body.internalNotes)
      if (body.packingNotes !== undefined) data.packingNotes = normalizeNote(body.packingNotes)
      if (body.trackingNumber !== undefined) data.trackingNumber = body.trackingNumber
      await tx.order.update({ where: { id: orderId, storeId }, data })

      const common = {
        storeId,
        orderId,
        orderNumber: order.orderNumber,
        actor: actorRef(actor)
      }
      this.events.publish(tx, Events.ORDER_UPDATED, common)
      if (overridden) this.events.publish(tx, Events.ORDER_PRICE_OVERRIDDEN, common)
      if (becamePending || reRequested) {
        this.events.publish(tx, Events.ORDER_PRICE_APPROVAL_REQUESTED, common)
      }
      const packingChanged =
        body.packingNotes !== undefined &&
        shouldWarnWarehouseOfPackingNote(status, order.packingNotes, body.packingNotes)
      if (packingChanged) this.events.publish(tx, Events.ORDER_PACKING_NOTE_CHANGED, common)
      return { order, lines, overridden, becamePending, withdrewRequest, discountChanged, data }
    })

    const { order } = outcome
    const trail = { storeId, orderId, actor }
    recordOrderAudit(this.audit, AuditAction.ORDER_UPDATED, trail, {
      orderNumber: order.orderNumber,
      fields: orderFieldsOfEdit(body),
      // The edit made a held request or approval unnecessary (the price is back inside the limit): cleared
      ...(outcome.withdrewRequest ? { priceRequestWithdrawn: true } : {})
    })
    if (body.scheduledDeliveryDate !== undefined) {
      const from = order.scheduledDeliveryDate?.toISOString().slice(0, 10) ?? null
      if (from !== body.scheduledDeliveryDate) {
        recordOrderAudit(this.audit, AuditAction.ORDER_SCHEDULE_CHANGED, trail, {
          from,
          to: body.scheduledDeliveryDate
        })
      }
    }
    // The notes are audited with the text before and after (owner, 2026-11-10): the entry is read by members with the
    // permission of the audit log, never by the customer, a channel or a plugin
    if (
      body.internalNotes !== undefined &&
      normalizeNote(body.internalNotes) !== normalizeNote(order.internalNotes)
    ) {
      recordOrderAudit(this.audit, AuditAction.ORDER_INTERNAL_NOTE_CHANGED, trail, {
        from: normalizeNote(order.internalNotes),
        to: normalizeNote(body.internalNotes)
      })
    }
    if (
      body.packingNotes !== undefined &&
      normalizeNote(body.packingNotes) !== normalizeNote(order.packingNotes)
    ) {
      recordOrderAudit(this.audit, AuditAction.ORDER_PACKING_NOTE_CHANGED, trail, {
        from: normalizeNote(order.packingNotes),
        to: normalizeNote(body.packingNotes)
      })
    }
    if (outcome.discountChanged) {
      recordOrderAudit(this.audit, AuditAction.ORDER_DISCOUNT_APPLIED, trail, {
        from: order.discountCents,
        discountCents: outcome.data.discountCents,
        reason: outcome.data.discountReason
      })
    }
    if (outcome.overridden) {
      recordOrderAudit(
        this.audit,
        AuditAction.ORDER_PRICE_OVERRIDDEN,
        trail,
        outcome.lines === null ? {} : this.overrideTrail(outcome.lines)
      )
    }
    if (outcome.becamePending) {
      recordOrderAudit(this.audit, AuditAction.ORDER_PRICE_APPROVAL_REQUESTED, trail, {
        discountCents: outcome.data.discountCents,
        shippingCents: outcome.data.shippingCents
      })
    }
    return this.get(storeId, orderId, held)
  }

  // The lines of an order, in the order they were asked; answers the id of each
  private async writeLines(
    tx: PrismaTransaction,
    orderId: string,
    lines: readonly OrderLine[]
  ): Promise<string[]> {
    // The ids are made here so that the lines go in one statement and the allocations can name them
    const ids = lines.map(() => randomUUID())
    await tx.orderItem.createMany({
      data: lines.map((line, index) => ({
        id: ids[index] as string,
        orderId,
        productId: line.productId,
        variantId: line.variantId,
        productName: line.productName,
        variantName: line.variantName,
        quantity: line.quantity,
        unitPriceCents: line.unitPriceCents,
        originalUnitPriceCents: line.originalUnitPriceCents,
        priceOverrideReason: line.priceOverrideReason,
        priceOverriddenBy: line.priceOverriddenBy,
        freeShipping: line.freeShipping
      }))
    })
    return ids
  }

  private overrideTrail(lines: readonly OrderLine[]): Record<string, unknown> {
    return {
      lines: lines
        .filter(line => line.originalUnitPriceCents !== null)
        .map(line => ({
          productId: line.productId,
          variantId: line.variantId,
          fromCents: line.originalUnitPriceCents,
          toCents: line.unitPriceCents,
          reason: line.priceOverrideReason
        }))
    }
  }
}
