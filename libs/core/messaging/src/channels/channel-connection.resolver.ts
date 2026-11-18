import { Injectable } from '@nestjs/common'

import { PrismaService, type PrismaTransaction } from '@platform/core/database'
import { ChannelConnectionStatus, isInstallationActive } from '@platform/core/domain'

import { enumValueOf } from '../conversations/conversations.support'

export interface ResolvedConnection {
  id: string
  storeId: string
  active: boolean
}

interface ConnectionRow {
  id: string
  store_id: string
  status: string
  installation_status: string
  plugin_status: string
}

// Who holds the account (plugin, connection id), whatever store it is of: the id, the store and the status, read through
// rls_resolve_channel_connection so that a store sees that ANOTHER store holds an account it wants (a plain read would not show
// that row once row security is enforced, and "nobody holds it" would be the wrong answer: a connect would try to take it, and a
// failed connect would tell the provider to drop an account that a live connection of another store uses).
export interface ConnectionHolder {
  id: string
  storeId: string
  status: string
}
export async function findConnectionHolder(
  db: Pick<PrismaTransaction, '$queryRaw'>,
  pluginId: string,
  connectionId: string
): Promise<ConnectionHolder | null> {
  const rows = await db.$queryRaw<ConnectionRow[]>`
    SELECT id, store_id, status, installation_status, plugin_status
    FROM rls_resolve_channel_connection(${pluginId}, ${connectionId})`
  const row = rows[0]
  if (row === undefined) return null
  // The answer is read as written: a row with no store would flow into queries as "no filter"
  if (
    typeof row.id !== 'string' ||
    typeof row.store_id !== 'string' ||
    typeof row.status !== 'string'
  ) {
    throw new TypeError('rls_resolve_channel_connection answered a row with no id, store or status')
  }
  return { id: row.id, storeId: row.store_id, status: row.status }
}

// Which store owns the recipient of an event. The store is the one of the connection found by
// (plugin, connection id) and no other: an event cannot name the store it wants, whoever sends it.
@Injectable()
export class ChannelConnectionResolver {
  constructor(private readonly prisma: PrismaService) {}

  // The store is not known yet, so this is the one lookup that runs before any context: rls_resolve_channel_connection answers the
  // connection and its statuses and nothing else (row security does not hide it from the application roles)
  async resolve(pluginId: string, connectionId: string): Promise<ResolvedConnection | null> {
    const rows = await this.prisma.client.$queryRaw<ConnectionRow[]>`
      SELECT id, store_id, status, installation_status, plugin_status
      FROM rls_resolve_channel_connection(${pluginId}, ${connectionId})`
    const row = rows[0]
    if (row === undefined) return null
    if (typeof row.id !== 'string' || typeof row.store_id !== 'string') {
      throw new TypeError('rls_resolve_channel_connection answered a row with no id or store')
    }
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
