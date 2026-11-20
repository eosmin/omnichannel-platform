import { Injectable } from '@nestjs/common'
import { PinoLogger } from 'nestjs-pino'

import { inSavepoint, PrismaService } from '@platform/core/database'
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

  // The reads are awaited by the caller (they run in the tenant transaction of the request) and each runs in a
  // savepoint, so that a read that fails and is caught here does not abort that transaction. The emit waits for
  // the commit: the visitor is not told of a read that was rolled back.
  async notify(storeId: string, conversationId: string): Promise<void> {
    try {
      const target = await inSavepoint(() => this.target(storeId, conversationId))
      if (target === null) return
      this.prisma.afterCommit(this.prisma.client, () => {
        this.delivery.readToVisitor(target.connectionId, target.channelIdentity, target.messageId)
      })
    } catch (error) {
      this.logger.warn(
        { conversationId, errorName: errorName(error) },
        'the widget read receipt could not be sent'
      )
    }
  }

  private async target(
    storeId: string,
    conversationId: string
  ): Promise<{ connectionId: string; channelIdentity: string; messageId: string } | null> {
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
    if (latest === null) return null
    const settings = await this.prisma.client.storeSettings.findUnique({
      where: { storeId },
      select: { preferences: true }
    })
    if (!readStorePreferences(settings?.preferences ?? {}).sendReadReceipts) return null
    return {
      connectionId: latest.conversation.channelConnection.connectionId,
      channelIdentity: latest.conversation.customerIdentity.channelIdentity,
      messageId: latest.id
    }
  }
}
