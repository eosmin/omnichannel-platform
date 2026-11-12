import { Injectable } from '@nestjs/common'

import { PrismaService } from '@platform/core/database'
import {
  type CursorPage,
  MembershipStatus,
  OrderMessageOutcomeStatus,
  OrderMessageRoutes
} from '@platform/core/domain'
import { resourceNotFound } from '@platform/core/errors'

import { encodeOrderMessageCursor, type ListOrderMessagesQuery } from './order-messages.schemas'

// One message about an order that was asked for, as the history of the order shows it. A state, a route, a kind or a reason stays
// text (open sets, TDD_17 §2): a value a newer server adds must still draw. The text of the message is never part of it.
export interface OrderMessageHistoryItem {
  id: string
  kind: string
  trigger: string
  route: string
  // The decision of the dispatch, not the delivery: 'sent' when the message went by a route (`deliveryStatus` says whether the channel
  // took it), 'not_sent' when it was recorded as one that could not go (with its reason).
  // 'sent' when the message went by a route, 'not_sent' when it was recorded as one that could not go (with its reason)
  status: typeof OrderMessageOutcomeStatus.SENT | typeof OrderMessageOutcomeStatus.NOT_SENT
  reason: string | null
  locale: string | null
  shipmentId: string | null
  // How the channel took the message (a value of DeliveryStatus) and why not when it failed; null for an email or a message
  // that was not sent
  deliveryStatus: string | null
  deliveryError: string | null
  // The member who pressed "send" or changed the status; null for the platform, or for a member who left the store
  requestedBy: { id: string; name: string } | null
  createdAt: string
}

// What was sent, or not sent and why, about one order (TDD_17 §4.7): the rows of `OrderMessageDispatch`, newest first.
@Injectable()
export class OrderMessageHistoryService {
  constructor(private readonly prisma: PrismaService) {}

  async list(
    storeId: string,
    orderId: string,
    query: ListOrderMessagesQuery
  ): Promise<CursorPage<OrderMessageHistoryItem>> {
    const order = await this.prisma.client.order.findFirst({
      where: { id: orderId, storeId },
      select: { id: true }
    })
    if (order === null) throw resourceNotFound('order')
    const { cursor } = query
    const rows = await this.prisma.client.orderMessageDispatch.findMany({
      where: {
        storeId,
        orderId,
        ...(cursor === undefined
          ? {}
          : {
              OR: [
                { createdAt: { lt: cursor.createdAt } },
                { createdAt: cursor.createdAt, id: { lt: cursor.id } }
              ]
            })
      },
      select: {
        id: true,
        kind: true,
        trigger: true,
        route: true,
        reason: true,
        locale: true,
        shipmentId: true,
        messageId: true,
        requestedBy: true,
        createdAt: true
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1
    })
    const hasMore = rows.length > query.limit
    const page = hasMore ? rows.slice(0, query.limit) : rows
    const messageIds = page.flatMap(row => (row.messageId === null ? [] : [row.messageId]))
    const memberIds = [
      ...new Set(page.flatMap(row => (row.requestedBy === null ? [] : [row.requestedBy])))
    ]
    const [messages, members] = await Promise.all([
      messageIds.length === 0
        ? []
        : this.prisma.client.message.findMany({
            where: { storeId, id: { in: messageIds } },
            select: { id: true, deliveryStatus: true, deliveryError: true }
          }),
      memberIds.length === 0
        ? []
        : this.prisma.client.membership.findMany({
            where: {
              storeId,
              userId: { in: memberIds },
              status: MembershipStatus.ACTIVE,
              revokedAt: null
            },
            select: { userId: true, user: { select: { name: true } } }
          })
    ])
    const deliveries = new Map(messages.map(message => [message.id, message]))
    const names = new Map(members.map(member => [member.userId, member.user.name]))
    const last = page.at(-1)
    return {
      data: page.map(row => {
        const delivery = row.messageId === null ? undefined : deliveries.get(row.messageId)
        const name = row.requestedBy === null ? undefined : names.get(row.requestedBy)
        return {
          id: row.id,
          kind: row.kind,
          trigger: row.trigger,
          route: row.route,
          status:
            row.route === OrderMessageRoutes.NOT_SENT
              ? OrderMessageOutcomeStatus.NOT_SENT
              : OrderMessageOutcomeStatus.SENT,
          reason: row.reason,
          locale: row.locale,
          shipmentId: row.shipmentId,
          deliveryStatus: delivery?.deliveryStatus ?? null,
          deliveryError: delivery?.deliveryError ?? null,
          requestedBy:
            row.requestedBy === null || name === undefined ? null : { id: row.requestedBy, name },
          createdAt: row.createdAt.toISOString()
        }
      }),
      nextCursor:
        hasMore && last !== undefined
          ? encodeOrderMessageCursor({ createdAt: last.createdAt, id: last.id })
          : null,
      hasMore
    }
  }
}
