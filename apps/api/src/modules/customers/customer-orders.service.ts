import { Injectable } from '@nestjs/common'

import { PrismaService } from '@platform/core/database'
import {
  type CursorPage,
  CustomerFigureOrderStatuses,
  type CustomerOrderFigures,
  customerOrderFigures
} from '@platform/core/domain'
import { resourceNotFound } from '@platform/core/errors'

import type { ListCustomerOrdersQuery } from './customers.schemas'
import { encodeCursor } from './list-cursor'

// What the profile of a customer shows of an order. The notes of the order (the customer's, the
// internal ones, the packing note), the address and the phones are NOT here: they have the order's own
// route and its own permission.
export interface CustomerOrderView {
  id: string
  orderNumber: string
  status: string
  paymentStatus: string
  totalCents: number
  currency: string
  itemCount: number
  createdAt: Date
}

export interface CustomerOrdersPage extends CursorPage<CustomerOrderView> {
  // Over every order the customer has, not only the page: on the first page only (null past a cursor),
  // so that "load more" does not add up the whole history again
  figures: CustomerOrderFigures | null
}

const ORDER_SELECT = {
  id: true,
  orderNumber: true,
  status: true,
  paymentStatus: true,
  totalCents: true,
  currency: true,
  createdAt: true,
  _count: { select: { items: true } }
} as const

// The orders of a customer of the store, the newest first, with the figures of the profile (orders,
// total spent, average order, first and last order: only the orders that count, see
// `CustomerFigureOrderStatuses`). Everything is scoped by the store of the request, so an id of another
// store's customer gets the same 404 as one that does not exist; an absorbed customer is not found, its
// orders are the survivor's.
@Injectable()
export class CustomerOrdersService {
  constructor(private readonly prisma: PrismaService) {}

  async list(
    storeId: string,
    customerId: string,
    query: ListCustomerOrdersQuery
  ): Promise<CustomerOrdersPage> {
    const customer = await this.prisma.client.customer.findFirst({
      where: { id: customerId, storeId, mergedIntoId: null },
      select: { id: true }
    })
    if (customer === null) throw resourceNotFound('customer')

    const { cursor, limit, status } = query
    const wantsFigures = cursor === undefined
    const [rows, aggregate] = await Promise.all([
      this.prisma.client.order.findMany({
        where: {
          storeId,
          customerId,
          ...(status === undefined ? {} : { status }),
          // Strictly after the last row of the previous page in (date, id) order
          ...(cursor === undefined
            ? {}
            : {
                OR: [
                  { createdAt: { lt: cursor.createdAt } },
                  { createdAt: cursor.createdAt, id: { lt: cursor.id } }
                ]
              })
        },
        select: ORDER_SELECT,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit + 1
      }),
      wantsFigures
        ? this.prisma.client.order.aggregate({
            where: { storeId, customerId, status: { in: [...CustomerFigureOrderStatuses] } },
            _count: { _all: true },
            _sum: { totalCents: true },
            _min: { createdAt: true },
            _max: { createdAt: true }
          })
        : null
    ])

    const hasMore = rows.length > limit
    const page = hasMore ? rows.slice(0, limit) : rows
    const last = page.at(-1)
    return {
      data: page.map(({ _count, ...row }) => ({ ...row, itemCount: _count.items })),
      nextCursor:
        hasMore && last !== undefined
          ? encodeCursor({ createdAt: last.createdAt, id: last.id })
          : null,
      hasMore,
      figures:
        aggregate === null
          ? null
          : customerOrderFigures({
              orders: aggregate._count._all,
              totalSpentCents: aggregate._sum.totalCents ?? 0,
              firstOrderAt: aggregate._min.createdAt,
              lastOrderAt: aggregate._max.createdAt
            })
    }
  }
}
