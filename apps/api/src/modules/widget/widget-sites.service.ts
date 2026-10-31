import { Injectable } from '@nestjs/common'

import { allowedOriginsOf, isSiteKey, preChatEnabledOf } from '@platform/channels/web-widget'
import { PrismaService } from '@platform/core/database'
import { ChannelConnectionStatus, ChannelIds } from '@platform/core/domain'

// A store's widget as the public routes see it
export interface WidgetSite {
  siteKey: string
  // ChannelConnection.id
  connectionId: string
  storeId: string
  storeName: string
  // Store.defaultLocale, which the widget speaks unless the snippet names another
  storeLocale: string
  allowedOrigins: readonly string[]
  // The widget asks the visitor for a name, an email and a phone before the first message
  preChatEnabled: boolean
}

// The door from a site key, which anyone can send, to the store it belongs to. Only an active
// connection of the widget plugin opens it: one that was disconnected, or a key of another channel,
// is the same "not found" as a key that never existed.
@Injectable()
export class WidgetSites {
  constructor(private readonly prisma: PrismaService) {}

  async find(siteKey: unknown): Promise<WidgetSite | null> {
    if (!isSiteKey(siteKey)) return null
    const row = await this.prisma.client.channelConnection.findUnique({
      where: { pluginId_connectionId: { pluginId: ChannelIds.WEB_WIDGET, connectionId: siteKey } },
      select: {
        id: true,
        storeId: true,
        status: true,
        metadata: true,
        store: { select: { name: true, defaultLocale: true } }
      }
    })
    if (row === null || row.status !== String(ChannelConnectionStatus.ACTIVE)) return null
    return {
      siteKey,
      connectionId: row.id,
      storeId: row.storeId,
      storeName: row.store.name,
      storeLocale: row.store.defaultLocale,
      allowedOrigins: allowedOriginsOf(row.metadata),
      preChatEnabled: preChatEnabledOf(row.metadata)
    }
  }
}
