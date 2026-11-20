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
