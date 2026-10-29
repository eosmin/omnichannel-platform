import { Injectable } from '@nestjs/common'
import { PinoLogger } from 'nestjs-pino'

import { PrismaService } from '@platform/core/database'
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

  // One job for the latest message of the customer that has an id at the channel (Meta marks the
  // earlier ones too). Never on receipt of a webhook: a blue tick says a person read it. Whether the
  // connection is active and its plugin sends read receipts is decided by the worker.
  async queueFor(storeId: string, conversationId: string): Promise<void> {
    try {
      const settings = await this.prisma.client.storeSettings.findUnique({
        where: { storeId },
        select: { preferences: true }
      })
      if (!readStorePreferences(settings?.preferences ?? {}).sendReadReceipts) return
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
      if (latest === null) return
      await this.outbound.enqueueReadReceipt({ storeId, conversationId, messageId: latest.id })
    } catch (error) {
      this.logger.warn(
        { conversationId, errorName: errorName(error) },
        'the read receipt could not be queued'
      )
    }
  }
}
