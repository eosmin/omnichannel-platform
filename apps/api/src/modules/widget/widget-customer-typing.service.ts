import { Injectable } from '@nestjs/common'
import { EventEmitter2 } from '@nestjs/event-emitter'

import { PrismaService } from '@platform/core/database'
import { ChannelIds, ConversationHiddenStatuses } from '@platform/core/domain'
import { Events } from '@platform/core/events'

// What the handshake of the socket already proved about the site of the visitor
export interface WidgetTypingSite {
  storeId: string
  // ChannelConnection.id
  connectionId: string
}

// The visitor is typing: the agents who have the conversation open are told. Nothing is stored, and a
// visitor with no conversation yet has nobody to tell. A conversation that is out of the inbox (archived
// or spam) is nobody's to be told about.
@Injectable()
export class WidgetCustomerTyping {
  constructor(
    private readonly prisma: PrismaService,
    private readonly emitter: EventEmitter2
  ) {}

  async signal(site: WidgetTypingSite, visitorId: string): Promise<void> {
    const conversation = await this.prisma.client.conversation.findFirst({
      where: {
        storeId: site.storeId,
        channelConnectionId: site.connectionId,
        status: { notIn: [...ConversationHiddenStatuses] },
        customerIdentity: { channelType: ChannelIds.WEB_WIDGET, channelIdentity: visitorId }
      },
      orderBy: [{ lastMessageAt: { sort: 'desc', nulls: 'last' } }, { id: 'desc' }],
      select: { id: true }
    })
    if (conversation === null) return
    await this.emitter.emitAsync(Events.CUSTOMER_TYPING, {
      storeId: site.storeId,
      conversationId: conversation.id
    })
  }
}
