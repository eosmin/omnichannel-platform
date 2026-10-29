import { Injectable } from '@nestjs/common'

import { PrismaService } from '@platform/core/database'
import {
  AuthorType,
  ChannelIds,
  DeliveryStatus,
  MessageType,
  WidgetLimits
} from '@platform/core/domain'

import { type WidgetMessageView, widgetMessageView } from './widget-message-view'
import type { WidgetSite } from './widget-sites.service'

// What a visitor may read of their own conversation with the store
@Injectable()
export class WidgetHistory {
  constructor(private readonly prisma: PrismaService) {}

  // The last messages the visitor and the store have exchanged on this widget, oldest first. Only text
  // that reached the visitor: not a note, a system line, a reply still waiting or one that failed, and
  // not a message that was deleted.
  async of(site: WidgetSite, visitorId: string): Promise<WidgetMessageView[]> {
    const rows = await this.prisma.client.message.findMany({
      where: {
        storeId: site.storeId,
        type: MessageType.TEXT,
        deletedAt: null,
        conversation: {
          channelConnectionId: site.connectionId,
          customerIdentity: { channelType: ChannelIds.WEB_WIDGET, channelIdentity: visitorId }
        },
        OR: [
          { authorType: AuthorType.CUSTOMER },
          {
            deliveryStatus: {
              in: [DeliveryStatus.SENT, DeliveryStatus.DELIVERED, DeliveryStatus.READ]
            }
          }
        ]
      },
      select: { id: true, content: true, authorType: true, createdAt: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: WidgetLimits.HISTORY_MESSAGES
    })
    return rows
      .map(row => widgetMessageView(row))
      .filter((view): view is WidgetMessageView => view !== null)
      .reverse()
  }
}
