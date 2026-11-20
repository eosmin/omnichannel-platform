import { Injectable } from '@nestjs/common'
import { PinoLogger } from 'nestjs-pino'

import { inSavepoint, PrismaService } from '@platform/core/database'
import { AuthorType } from '@platform/core/domain'
import { errorName } from '@platform/core/errors'
import { readStorePreferences } from '@platform/core/store-preferences'

import { OutboundQueue } from './outbound-queue'

// Tells the customer's channel that an agent read the conversation. It is called after the read is
// stored and never changes it: whatever goes wrong here is logged and the read stands.
@Injectable()
export class ReadReceipts {
  constructor(
    private readonly prisma: PrismaService,
    private readonly outbound: OutboundQueue,
    private readonly logger: PinoLogger
  ) {
    this.logger.setContext(ReadReceipts.name)
  }

  // One job for the latest message of the customer that has an id at the channel (the provider marks the
  // earlier ones too). Never on receipt of a webhook: a blue tick says a person read it. Whether the
  // connection is active and its plugin sends read receipts is decided by the worker.
  // The reads are awaited: they run in the tenant transaction of the request, which closes once the answer is
  // sent. Each runs in a savepoint, because a read that fails and is caught here would otherwise abort the
  // transaction of the request and roll the read itself back. The queueing (Redis, which may be slow) starts
  // once that transaction has committed, is not awaited, and its failure is logged here.
  async queueFor(storeId: string, conversationId: string): Promise<void> {
    try {
      const messageId = await inSavepoint(() => this.latestToMark(storeId, conversationId))
      if (messageId === null) return
      this.prisma.afterCommit(this.prisma.client, () => {
        this.outbound
          .enqueueReadReceipt({ storeId, conversationId, messageId })
          .catch((error: unknown) => this.logQueueFailure(conversationId, error))
      })
    } catch (error) {
      this.logQueueFailure(conversationId, error)
    }
  }

  // The same as `queueFor` for the conversations of a bulk action that went through (never one that failed): the switch of the
  // store is read once and the latest message of every conversation comes from one query, so the cost does not grow with the
  // number of conversations. `upTo` is the clock of the database when the batch began: a message that arrived while the batch ran
  // was not read by anyone, so no receipt may point at it. Each conversation with a message to mark gets its own job, with the same arguments as `queueFor`.
  // `storeId` is the one of the request; the query filters by it, so an id of another store finds nothing.
  async queueForMany(
    storeId: string,
    conversationIds: readonly string[],
    upTo: Date
  ): Promise<void> {
    if (conversationIds.length === 0) return
    try {
      const targets = await inSavepoint(() => this.latestToMarkMany(storeId, conversationIds, upTo))
      for (const [conversationId, messageId] of targets) {
        this.prisma.afterCommit(this.prisma.client, () => {
          this.outbound
            .enqueueReadReceipt({ storeId, conversationId, messageId })
            .catch((error: unknown) => this.logQueueFailure(conversationId, error))
        })
      }
    } catch (error) {
      // One failure loses the receipts of the whole batch (the reads stand): say how many
      this.logger.warn(
        { conversations: conversationIds.length, errorName: errorName(error) },
        'the read receipts of a batch could not be queued'
      )
    }
  }

  private async latestToMarkMany(
    storeId: string,
    conversationIds: readonly string[],
    upTo: Date
  ): Promise<Map<string, string>> {
    const found = new Map<string, string>()
    const settings = await this.prisma.client.storeSettings.findUnique({
      where: { storeId },
      select: { preferences: true }
    })
    if (!readStorePreferences(settings?.preferences ?? {}).sendReadReceipts) return found
    // The same filters and tie-break as `latestToMark`
    const rows = await this.prisma.client.$queryRaw<{ conversation_id: string; id: string }[]>`
      SELECT DISTINCT ON (conversation_id) conversation_id, id
      FROM messages
      WHERE store_id = ${storeId}
        AND conversation_id = ANY(${[...conversationIds]}::text[])
        AND author_type = ${AuthorType.CUSTOMER}
        AND channel_message_id IS NOT NULL
        AND deleted_at IS NULL
        AND created_at <= ${upTo.toISOString()}::timestamp
      ORDER BY conversation_id, created_at DESC, id DESC`
    for (const row of rows) found.set(row.conversation_id, row.id)
    return found
  }

  private async latestToMark(storeId: string, conversationId: string): Promise<string | null> {
    const settings = await this.prisma.client.storeSettings.findUnique({
      where: { storeId },
      select: { preferences: true }
    })
    if (!readStorePreferences(settings?.preferences ?? {}).sendReadReceipts) return null
    const latest = await this.prisma.client.message.findFirst({
      where: {
        storeId,
        conversationId,
        authorType: AuthorType.CUSTOMER,
        channelMessageId: { not: null },
        // A message the customer took back has nothing to be marked at the channel
        deletedAt: null
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { id: true }
    })
    return latest?.id ?? null
  }

  private logQueueFailure(conversationId: string, error: unknown): void {
    this.logger.warn(
      { conversationId, errorName: errorName(error) },
      'the read receipt could not be queued'
    )
  }
}
