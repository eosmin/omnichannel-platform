import type { PrismaService } from '@platform/core/database'
import { calendarDayToDate, dateToCalendarDay } from '@platform/core/domain'
import { ExportLimits } from '@platform/core/exports'
import { orderListWhere, type OrdersExportFilters } from '@platform/core/messaging'

import type { CsvSource } from './csv-export-writer'

// The orders CSV (Step 4.4). One row per order, money in whole cents of the order currency. What stays out, because it is
// internal or not the customer's to read in a spreadsheet that travels: the three notes, the payment reference and the
// receipt, the address and the recipient phones, who made, confirmed or approved the order, and the reasons.
export const ORDER_COLUMNS = [
  'order_number',
  'created_at',
  'status',
  'payment_status',
  'payment_method',
  'customer_id',
  'customer_name',
  'customer_email',
  'customer_phone',
  'lines',
  'units',
  'subtotal_cents',
  'shipping_cents',
  'discount_cents',
  'total_cents',
  'currency',
  'free_shipping',
  'price_modified',
  'price_approval_status',
  'scheduled_delivery_date',
  'confirmed_at',
  'shipped_at',
  'delivered_at',
  'cancelled_at'
] as const

export function ordersExportSource(
  prisma: PrismaService,
  storeId: string,
  filters: OrdersExportFilters
): CsvSource {
  const where = {
    ...orderListWhere(storeId, {
      q: filters.q,
      status: filters.status,
      paymentStatus: filters.paymentStatus,
      priceApprovalStatus: filters.priceApprovalStatus,
      customerId: filters.customerId,
      createdFrom: filters.createdFrom === undefined ? undefined : new Date(filters.createdFrom),
      createdBefore:
        filters.createdBefore === undefined ? undefined : new Date(filters.createdBefore)
    }),
    ...(filters.scheduledDeliveryFrom === undefined && filters.scheduledDeliveryTo === undefined
      ? {}
      : {
          scheduledDeliveryDate: {
            ...(filters.scheduledDeliveryFrom === undefined
              ? {}
              : { gte: calendarDayToDate(filters.scheduledDeliveryFrom) }),
            ...(filters.scheduledDeliveryTo === undefined
              ? {}
              : { lte: calendarDayToDate(filters.scheduledDeliveryTo) })
          }
        })
  }
  return {
    columns: ORDER_COLUMNS,
    count: () => prisma.client.order.count({ where }),
    rows: async function* () {
      // Keyset on the list's own order (newest first): a row deleted meanwhile cannot end the file early
      let after: { createdAt: Date; id: string } | undefined
      for (;;) {
        const orders = await prisma.client.order.findMany({
          where: {
            ...where,
            ...(after === undefined
              ? {}
              : {
                  OR: [
                    { createdAt: { lt: after.createdAt } },
                    { createdAt: after.createdAt, id: { lt: after.id } }
                  ]
                })
          },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: ExportLimits.ROW_PAGE_SIZE,
          select: {
            id: true,
            orderNumber: true,
            createdAt: true,
            status: true,
            paymentStatus: true,
            paymentMethod: true,
            customerId: true,
            customer: { select: { name: true, email: true, phone: true } },
            subtotalCents: true,
            shippingCents: true,
            discountCents: true,
            totalCents: true,
            currency: true,
            freeShipping: true,
            priceApprovalStatus: true,
            scheduledDeliveryDate: true,
            confirmedAt: true,
            shippedAt: true,
            deliveredAt: true,
            cancelledAt: true,
            _count: { select: { items: true } }
          }
        })
        const last = orders.at(-1)
        if (last === undefined) return
        after = { createdAt: last.createdAt, id: last.id }

        const ids = orders.map(order => order.id)
        // The units of the whole page in ONE grouped read, and the lines whose price was changed
        const units = await prisma.client.orderItem.groupBy({
          by: ['orderId'],
          where: { orderId: { in: ids }, order: { storeId } },
          _sum: { quantity: true }
        })
        const unitsOf = new Map(units.map(row => [row.orderId, row._sum.quantity ?? 0]))
        const modified = await prisma.client.orderItem.groupBy({
          by: ['orderId'],
          where: {
            orderId: { in: ids },
            order: { storeId },
            originalUnitPriceCents: { not: null }
          },
          _count: { _all: true }
        })
        const modifiedIds = new Set(modified.map(row => row.orderId))

        for (const order of orders) {
          yield [
            order.orderNumber,
            order.createdAt,
            order.status,
            order.paymentStatus,
            order.paymentMethod,
            order.customerId,
            order.customer.name,
            order.customer.email,
            order.customer.phone,
            order._count.items,
            unitsOf.get(order.id) ?? 0,
            order.subtotalCents,
            order.shippingCents,
            order.discountCents,
            order.totalCents,
            order.currency,
            order.freeShipping,
            modifiedIds.has(order.id),
            order.priceApprovalStatus,
            order.scheduledDeliveryDate === null
              ? null
              : dateToCalendarDay(order.scheduledDeliveryDate),
            order.confirmedAt,
            order.shippedAt,
            order.deliveredAt,
            order.cancelledAt
          ]
        }
      }
    }
  }
}
