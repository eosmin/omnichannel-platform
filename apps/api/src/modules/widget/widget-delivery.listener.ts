import { Injectable } from '@nestjs/common'
import { OnEvent } from '@nestjs/event-emitter'

import { PrismaService } from '@platform/core/database'
import { AuthorType } from '@platform/core/domain'
import { Events, type MessageStatusPayload } from '@platform/core/events'

import { WidgetDelivery } from './widget-delivery.service'
import {
  LIVE_DELIVERY_CONNECTION,
  WIDGET_FILES_SELECT,
  WIDGET_VISIBLE_TYPES,
  widgetMessageView
} from './widget-message-view'

// A reply (text or file) the channel has taken goes to the visitor who is waiting for it. The domain event carries
// ids only, so the message is read here, and only a reply on a conversation of the widget is passed on.
@Injectable()
export class WidgetDeliveryListener {
  constructor(
    private readonly prisma: PrismaService,
    private readonly delivery: WidgetDelivery
  ) {}

  @OnEvent(Events.MESSAGE_SENT)
  async onSent(payload: MessageStatusPayload): Promise<void> {
    const message = await this.prisma.client.message.findFirst({
      where: {
        id: payload.messageId,
        storeId: payload.storeId,
        type: { in: [...WIDGET_VISIBLE_TYPES] },
        deletedAt: null,
        authorType: { not: AuthorType.CUSTOMER },
        conversation: { channelConnection: LIVE_DELIVERY_CONNECTION }
      },
      select: {
        id: true,
        content: true,
        authorType: true,
        createdAt: true,
        media: WIDGET_FILES_SELECT,
        conversation: {
          select: {
            channelConnection: { select: { connectionId: true } },
            customerIdentity: { select: { channelIdentity: true } }
          }
        }
      }
    })
    if (message === null) return
    const view = widgetMessageView(message)
    if (view === null) return
    this.delivery.toVisitor(
      message.conversation.channelConnection.connectionId,
      message.conversation.customerIdentity.channelIdentity,
      view
    )
  }
}
