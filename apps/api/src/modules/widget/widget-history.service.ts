import { Injectable } from '@nestjs/common'

import { PrismaService } from '@platform/core/database'
import { AuthorType, ChannelIds, WidgetLimits } from '@platform/core/domain'
import { readStorePreferences } from '@platform/core/store-preferences'

import {
  type WidgetMessageView,
  WIDGET_FILES_SELECT,
  WIDGET_VISIBLE_TYPES,
  visitorMessagesWhere,
  widgetMessageView
} from './widget-message-view'
import type { WidgetSite } from './widget-sites.service'

// What a visitor may read of their own conversation with the store
@Injectable()
export class WidgetHistory {
  constructor(private readonly prisma: PrismaService) {}

  // The last messages the visitor and the store have exchanged on this widget, oldest first. Only what
  // reached the visitor (see `visitorMessagesWhere`): not a note, a system line, a reply still waiting
  // or one that failed, and not a message that was deleted. A message of files shows the files the scan
  // found clean.
  async of(site: WidgetSite, visitorId: string): Promise<WidgetMessageView[]> {
    const rows = await this.prisma.client.message.findMany({
      // Something to show is part of the query, or a message of files not yet clean would use up one of
      // the slots of the window and push an older real message out
      where: {
        ...visitorMessagesWhere(site, visitorId),
        AND: [{ OR: [{ content: { not: null } }, { media: { some: WIDGET_FILES_SELECT.where } }] }]
      },
      select: {
        id: true,
        content: true,
        authorType: true,
        createdAt: true,
        media: WIDGET_FILES_SELECT
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: WidgetLimits.HISTORY_MESSAGES
    })
    return rows
      .map(row => widgetMessageView(row))
      .filter((view): view is WidgetMessageView => view !== null)
      .reverse()
  }

  // The latest message of the visitor that an agent has read, for a visitor who comes back after
  // the live "read" was sent. `lastReadAt` is the moment of the last read of the conversation, and
  // "mark as unread" moves it back before the last message. Null when the store sends no read
  // receipts, as for the live ones, or nothing of the visitor was read.
  async readUpTo(site: WidgetSite, visitorId: string): Promise<string | null> {
    const settings = await this.prisma.client.storeSettings.findUnique({
      where: { storeId: site.storeId },
      select: { preferences: true }
    })
    if (!readStorePreferences(settings?.preferences ?? {}).sendReadReceipts) return null
    // The history spans every conversation of the visitor on this widget, so the read does too: each
    // one is cut at its own moment of last read
    const conversations = await this.prisma.client.conversation.findMany({
      where: {
        storeId: site.storeId,
        channelConnectionId: site.connectionId,
        customerIdentity: { channelType: ChannelIds.WEB_WIDGET, channelIdentity: visitorId },
        lastReadAt: { not: null }
      },
      select: { id: true, lastReadAt: true }
    })
    const read = conversations.flatMap(({ id, lastReadAt }) =>
      lastReadAt === null ? [] : [{ conversationId: id, createdAt: { lte: lastReadAt } }]
    )
    if (read.length === 0) return null
    const latest = await this.prisma.client.message.findFirst({
      where: {
        storeId: site.storeId,
        authorType: AuthorType.CUSTOMER,
        type: { in: [...WIDGET_VISIBLE_TYPES] },
        deletedAt: null,
        // Something to be seen: a text, or a file that is clean
        AND: [
          { OR: read },
          { OR: [{ content: { not: null } }, { media: { some: WIDGET_FILES_SELECT.where } }] }
        ]
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { id: true }
    })
    return latest?.id ?? null
  }
}
