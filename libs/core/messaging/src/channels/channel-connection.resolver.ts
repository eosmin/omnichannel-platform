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
    // The store is not known yet, so this is the one lookup that runs before any context: a function of the database that answers
    // the connection and its statuses, nothing else (row security does not hide it from the role of the worker)
    const [row] = await this.prisma.client.$queryRaw<
      {
        id: string
        store_id: string
        status: string
        installation_status: string
        plugin_status: string
      }[]
    >`SELECT id, store_id, status, installation_status, plugin_status
      FROM rls_resolve_channel_connection(${pluginId}, ${connectionId})`
    if (row === undefined) return null
    return {
      id: row.id,
      storeId: row.store_id,
      active:
        enumValueOf(ChannelConnectionStatus, row.status, 'channel connection status') !==
          ChannelConnectionStatus.DISCONNECTED &&
        isInstallationActive({
          status: row.installation_status,
          plugin: { status: row.plugin_status }
        })
    }
  }
}
