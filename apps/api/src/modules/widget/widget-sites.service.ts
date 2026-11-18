import { Injectable } from '@nestjs/common'

import { allowedOriginsOf, isSiteKey, preChatEnabledOf } from '@platform/channels/web-widget'
import { contextOf, PrismaService, resolveWidgetSite } from '@platform/core/database'
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
// is the same as a key that never existed. The routes turn that into the same 403 as a site that is not
// listed (`allowOrigin`), never a 404, so the answers do not tell which keys exist.
@Injectable()
export class WidgetSites {
  constructor(private readonly prisma: PrismaService) {}

  async find(siteKey: unknown): Promise<WidgetSite | null> {
    if (!isSiteKey(siteKey)) return null
    // The site key says which store it is only to the database: the lookup finds the connection and its store, and the row is read
    // inside the context of that store (the status, the origins and the store's name are the connection's and the store's)
    const found = await resolveWidgetSite(this.prisma.client, ChannelIds.WEB_WIDGET, siteKey)
    if (found === null) return null
    const row = await this.prisma.tenantTransaction(contextOf(found), () =>
      this.prisma.client.channelConnection.findFirst({
        where: { id: found.id, storeId: found.storeId },
        select: {
          id: true,
          storeId: true,
          status: true,
          metadata: true,
          store: { select: { name: true, defaultLocale: true } }
        }
      })
    )
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
