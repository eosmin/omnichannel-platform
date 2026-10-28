import { Injectable } from '@nestjs/common'

import { PrismaService } from '@platform/core/database'
import { ChannelConnectionStatus, isInstallationActive } from '@platform/core/domain'

import { enumValueOf } from '../conversations/conversations.support'

export interface ResolvedConnection {
  id: string
  storeId: string
  active: boolean
}

// Which store owns the recipient of an event. The store is the one of the connection found by
// (plugin, connection id) and no other: an event cannot name the store it wants, whoever sends it.
@Injectable()
export class ChannelConnectionResolver {
  constructor(private readonly prisma: PrismaService) {}

  async resolve(pluginId: string, connectionId: string): Promise<ResolvedConnection | null> {
    const row = await this.prisma.client.channelConnection.findUnique({
      where: { pluginId_connectionId: { pluginId, connectionId } },
      select: {
        id: true,
        storeId: true,
        status: true,
        installation: { select: { status: true, plugin: { select: { status: true } } } }
      }
    })
    if (row === null) return null
    return {
      id: row.id,
      storeId: row.storeId,
      active:
        enumValueOf(ChannelConnectionStatus, row.status, 'channel connection status') !==
          ChannelConnectionStatus.DISCONNECTED && isInstallationActive(row.installation)
    }
  }
}
