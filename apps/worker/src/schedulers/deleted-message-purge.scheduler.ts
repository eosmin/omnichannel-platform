import { Injectable } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import { PinoLogger } from 'nestjs-pino'

import { errorName } from '@platform/channels/connections'
import {
  JobContext,
  JobContextError,
  JobContextGoneError,
  PrismaService
} from '@platform/core/database'
import { DeletedMessageRetention } from '@platform/core/domain'
import { LockNames, Schedules } from '@platform/core/queues'

import { LeaderLockService } from './leader-lock.service'
import { allStoreIds } from './store-sweep'

// rls-context: the stores are listed from `stores`; the messages, revisions and files of each store are read and written inside JobContext.forStore

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

  // Store by store, each in its own context. The purge acts only on rows it finds due, so a store that fails must not hold back the
  // retention deadline of the others: it is logged and left to the next run. When more than half of the stores fail the run throws (a
  // pool that is down must not look like "nothing due").
  async purge(now: Date = new Date()): Promise<number> {
    const storeIds = await allStoreIds(this.prisma)
    let total = 0
    let failed = 0
    for (const storeId of storeIds) {
      try {
        const purged = await this.purgeStore(storeId, now)
        total += purged
        if (purged === DeletedMessageRetention.PURGE_BATCH) {
          this.logger.warn(
            { storeId, purged },
            'a full batch of deleted messages was purged; more may wait'
          )
        }
      } catch (error) {
        // A store deleted between the list and its turn has nothing left to purge
        if (error instanceof JobContextGoneError) continue
        failed += 1
        this.logger.error(
          { storeId, errorName: errorName(error) },
          'the deleted messages of a store could not be purged'
        )
      }
    }
    if (failed > 0 && failed * 2 > storeIds.length) {
      throw new JobContextError(`the purge could not run in ${failed} of ${storeIds.length} stores`)
    }
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
