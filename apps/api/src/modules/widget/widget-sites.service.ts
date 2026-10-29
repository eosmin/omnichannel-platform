import { Injectable } from '@nestjs/common'
import { z } from 'zod'

import { isSiteKey } from '@platform/channels/web-widget'
import { PrismaService } from '@platform/core/database'
import { ChannelConnectionStatus, ChannelIds, WidgetMetadataKeys } from '@platform/core/domain'

// What the origins of a connection look like in its metadata; a connection whose metadata is not this
// allows no site, which is the safe reading
const metadataSchema = z.object({
  [WidgetMetadataKeys.ALLOWED_ORIGINS]: z.array(z.string())
})

// A store's widget as the public routes see it
export interface WidgetSite {
  siteKey: string
  // ChannelConnection.id
  connectionId: string
  storeId: string
  storeName: string
  allowedOrigins: readonly string[]
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
        store: { select: { name: true } }
      }
    })
    if (row === null || row.status !== String(ChannelConnectionStatus.ACTIVE)) return null
    const metadata = metadataSchema.safeParse(row.metadata)
    return {
      siteKey,
      connectionId: row.id,
      storeId: row.storeId,
      storeName: row.store.name,
      allowedOrigins: metadata.success ? metadata.data[WidgetMetadataKeys.ALLOWED_ORIGINS] : []
    }
  }
}
