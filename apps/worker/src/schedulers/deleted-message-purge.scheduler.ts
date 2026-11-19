import { Injectable } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import { PinoLogger } from 'nestjs-pino'

import { errorName } from '@platform/channels/connections'
import { JobContext, PrismaService } from '@platform/core/database'
import { DeletedMessageRetention } from '@platform/core/domain'
import { LockNames, Schedules } from '@platform/core/queues'

import { LeaderLockService } from './leader-lock.service'
import { inEachStoreStrict } from './store-sweep'

const LOCK_SECONDS = 600
const DAY_MS = 86_400_000

// A deleted message (by the customer, the owner or an agent) keeps its text for
// DeletedMessageRetention.DAYS, for disputes, and then loses it:
// the text of the message and of its revisions. The row stays, as the tombstone the thread shows. Each
// run purges one batch, oldest first, and says when a batch was full so that the backlog is visible.
@Injectable()
export class DeletedMessagePurgeScheduler {
  constructor(
    private readonly locks: LeaderLockService,
    private readonly prisma: PrismaService,
    private readonly jobContext: JobContext,
    private readonly logger: PinoLogger
  ) {
    this.logger.setContext(DeletedMessagePurgeScheduler.name)
  }

  @Cron(Schedules.PURGE_DELETED_MESSAGES)
  async run(): Promise<void> {
    try {
      await this.locks.withLock(LockNames.PURGE_DELETED_MESSAGES, LOCK_SECONDS, async () => {
        await this.purge()
      })
    } catch (error) {
      // A cron that throws must not take the worker down; the next hour tries again
      this.logger.error({ errorName: errorName(error) }, 'the purge of deleted messages failed')
    }
  }

  // Store by store, each in its own context. A purge decides by what it finds in the store, so a store that cannot be read aborts the
  // run (the next hour tries again): none is skipped as if it had nothing due. Each store purges one batch.
  async purge(now: Date = new Date()): Promise<number> {
    let total = 0
    await inEachStoreStrict(this.prisma, async storeId => {
      const purged = await this.purgeStore(storeId, now)
      total += purged
      if (purged === DeletedMessageRetention.PURGE_BATCH) {
        this.logger.warn(
          { storeId, purged },
          'a full batch of deleted messages was purged; more may wait'
        )
      }
    })
    return total
  }

  private async purgeStore(storeId: string, now: Date): Promise<number> {
    const due = await this.jobContext.forStore(storeId, () =>
      this.prisma.client.message.findMany({
        where: {
          storeId,
          deletedAt: { lt: new Date(now.getTime() - DeletedMessageRetention.DAYS * DAY_MS) },
          contentPurgedAt: null
        },
        select: { id: true },
        orderBy: [{ deletedAt: 'asc' }, { id: 'asc' }],
        take: DeletedMessageRetention.PURGE_BATCH
      })
    )
    if (due.length === 0) return 0
    const messageIds = due.map(message => message.id)
    await this.jobContext.forStore(storeId, () =>
      this.prisma.transaction(async tx => {
        await tx.messageRevision.updateMany({
          where: { storeId, messageId: { in: messageIds } },
          data: { content: null }
        })
        // The text under each file is content too (the first file's included, since the text of a message can go
        // apart from it): it goes with the text of the message
        await tx.media.updateMany({
          where: { storeId, messageId: { in: messageIds }, caption: { not: null } },
          data: { caption: null }
        })
        await tx.message.updateMany({
          where: { storeId, id: { in: messageIds }, contentPurgedAt: null },
          data: {
            content: null,
            pendingContent: null,
            pendingEditPluginId: null,
            changeRequestedAt: null,
            contentPurgedAt: now
          }
        })
      })
    )
    return messageIds.length
  }
}
