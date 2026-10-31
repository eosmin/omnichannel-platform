import { Injectable } from '@nestjs/common'
import { PinoLogger } from 'nestjs-pino'

import { PrismaService } from '@platform/core/database'
import { AuthorType, ChannelConnectionStatus, ChannelIds } from '@platform/core/domain'
import { errorName } from '@platform/core/errors'
import { readStorePreferences } from '@platform/core/store-preferences'

import { WidgetDelivery } from './widget-delivery.service'

// Tells the visitor of the web widget that an agent read the conversation. The worker cannot reach a
// visitor's socket, so this runs in the api next to the read itself (the other channels get theirs
// through `ReadReceipts`). It follows the same switch of the store (`sendReadReceipts`), never changes
// the read, and whatever goes wrong here is logged.
@Injectable()
export class WidgetReadNotifier {
  constructor(
    private readonly prisma: PrismaService,
    private readonly delivery: WidgetDelivery,
    private readonly logger: PinoLogger
  ) {
    this.logger.setContext(WidgetReadNotifier.name)
  }

  async notify(storeId: string, conversationId: string): Promise<void> {
    try {
      // Only a conversation of the widget is looked into, so that every other channel costs one query
      const latest = await this.prisma.client.message.findFirst({
        where: {
          storeId,
          conversationId,
          authorType: AuthorType.CUSTOMER,
          // A message with no text is not shown to the visitor, and a deleted one is gone
          deletedAt: null,
          content: { not: null },
          conversation: {
            channelConnection: {
              pluginId: ChannelIds.WEB_WIDGET,
              status: ChannelConnectionStatus.ACTIVE
            }
          }
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: {
          id: true,
          conversation: {
            select: {
              channelConnection: { select: { connectionId: true } },
              customerIdentity: { select: { channelIdentity: true } }
            }
          }
        }
      })
      if (latest === null) return
      const settings = await this.prisma.client.storeSettings.findUnique({
        where: { storeId },
        select: { preferences: true }
      })
      if (!readStorePreferences(settings?.preferences ?? {}).sendReadReceipts) return
      this.delivery.readToVisitor(
        latest.conversation.channelConnection.connectionId,
        latest.conversation.customerIdentity.channelIdentity,
        latest.id
      )
    } catch (error) {
      this.logger.warn(
        { conversationId, errorName: errorName(error) },
        'the widget read receipt could not be sent'
      )
    }
  }
}
