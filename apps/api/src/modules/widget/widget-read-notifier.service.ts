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

  // The same as `notify` for the conversations of a bulk action that went through: the switch of the store is read once and the
  // latest message of every conversation of the widget comes from one query. One emit per conversation with a target, with the
  // same arguments as `notify`; `upTo` (the clock of the database when the batch began) keeps out a message that arrived while the
  // batch ran, which nobody read. The query filters by the store of the request, so an id of another store finds nothing.
  async notifyMany(storeId: string, conversationIds: readonly string[], upTo: Date): Promise<void> {
    if (conversationIds.length === 0) return
    try {
      const targets = await inSavepoint(() => this.targets(storeId, conversationIds, upTo))
      for (const target of targets) {
        this.prisma.afterCommit(this.prisma.client, () => {
          this.delivery.readToVisitor(target.connectionId, target.channelIdentity, target.messageId)
        })
      }
    } catch (error) {
      // One failure loses the notices of the whole batch (the reads stand): say how many
      this.logger.warn(
        { conversations: conversationIds.length, errorName: errorName(error) },
        'the widget read receipts of a batch could not be sent'
      )
    }
  }

  private async targets(
    storeId: string,
    conversationIds: readonly string[],
    upTo: Date
  ): Promise<{ connectionId: string; channelIdentity: string; messageId: string }[]> {
    const settings = await this.prisma.client.storeSettings.findUnique({
      where: { storeId },
      select: { preferences: true }
    })
    if (!readStorePreferences(settings?.preferences ?? {}).sendReadReceipts) return []
    // The same filters and tie-break as `target`
    const rows = await this.prisma.client.$queryRaw<
      { id: string; connection_id: string; channel_identity: string }[]
    >`
      SELECT DISTINCT ON (m.conversation_id) m.id, cc.connection_id, ci.channel_identity
      FROM messages m
      JOIN conversations c ON c.id = m.conversation_id AND c.store_id = ${storeId}
      JOIN channel_connections cc ON cc.id = c.channel_connection_id AND cc.store_id = ${storeId}
      JOIN customer_identities ci ON ci.id = c.customer_identity_id AND ci.store_id = ${storeId}
      WHERE m.store_id = ${storeId}
        AND m.conversation_id = ANY(${[...conversationIds]}::text[])
        AND m.author_type = ${AuthorType.CUSTOMER}
        AND m.deleted_at IS NULL
        AND m.content IS NOT NULL
        AND m.created_at <= ${upTo.toISOString()}::timestamp
        AND cc.plugin_id = ${ChannelIds.WEB_WIDGET}
        AND cc.status = ${ChannelConnectionStatus.ACTIVE}
      ORDER BY m.conversation_id, m.created_at DESC, m.id DESC`
    return rows.map(row => ({
      connectionId: row.connection_id,
      channelIdentity: row.channel_identity,
      messageId: row.id
    }))
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
