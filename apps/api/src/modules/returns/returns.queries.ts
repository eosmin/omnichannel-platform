import { Injectable } from '@nestjs/common'

import { PrismaService } from '@platform/core/database'
import { type CursorPage, nextCalendarDay, startOfCalendarDayIn } from '@platform/core/domain'
import { resourceNotFound } from '@platform/core/errors'

import { encodeCursor } from '../customers/list-cursor'

import type { ListReturnsQuery } from './returns.schemas'
import { RETURN_SELECT, type ReturnView, returnViewOf } from './returns.views'

const ORDER = [{ createdAt: 'desc' }, { id: 'desc' }] as const

// What the screens read of the returns of the store: the shapes of the answers. Every change is `ReturnsService`'s
// (libs/core/shipping), which is the only writer of a status.
@Injectable()
export class ReturnsQueries {
  constructor(private readonly prisma: PrismaService) {}

  async list(storeId: string, query: ListReturnsQuery): Promise<CursorPage<ReturnView>> {
    const { cursor, limit } = query
    // The days are the store's calendar days: its clock is read only when a day is asked for
    const needsClock = query.createdFrom !== undefined || query.createdTo !== undefined
    const store = needsClock
      ? await this.prisma.client.store.findUnique({
          where: { id: storeId },
          select: { timezone: true }
        })
      : null
    if (needsClock && store === null) throw resourceNotFound('store')
    const timezone = store?.timezone ?? ''
    const createdAt = {
      ...(query.createdFrom === undefined
        ? {}
        : { gte: startOfCalendarDayIn(timezone, query.createdFrom) }),
      ...(query.createdTo === undefined
        ? {}
        : { lt: startOfCalendarDayIn(timezone, nextCalendarDay(query.createdTo)) })
    }
    const rows = await this.prisma.client.orderReturn.findMany({
      where: {
        storeId,
        ...(query.status === undefined ? {} : { status: query.status }),
        ...(query.orderId === undefined ? {} : { orderId: query.orderId }),
        ...(query.orderNumber === undefined
          ? {}
          : { order: { storeId, orderNumber: query.orderNumber } }),
        ...(Object.keys(createdAt).length === 0 ? {} : { createdAt }),
        ...(cursor === undefined
          ? {}
          : {
              OR: [
                { createdAt: { lt: cursor.createdAt } },
                { createdAt: cursor.createdAt, id: { lt: cursor.id } }
              ]
            })
      },
      select: RETURN_SELECT,
      orderBy: [...ORDER],
      take: limit + 1
    })
    const hasMore = rows.length > limit
    const page = hasMore ? rows.slice(0, limit) : rows
    const last = page.at(-1)
    return {
      data: page.map(row => returnViewOf(row)),
      nextCursor: hasMore && last !== undefined ? encodeCursor(last) : null,
      hasMore
    }
  }

  async get(storeId: string, returnId: string): Promise<ReturnView> {
    const row = await this.prisma.client.orderReturn.findFirst({
      where: { id: returnId, storeId },
      select: RETURN_SELECT
    })
    if (row === null) throw resourceNotFound('return')
    return returnViewOf(row)
  }
}
