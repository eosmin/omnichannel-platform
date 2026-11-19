import { Injectable } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import { PinoLogger } from 'nestjs-pino'

import { errorName } from '@platform/channels/connections'
import { JobContext, PrismaService } from '@platform/core/database'
import { ConversationStatus, ConversationStatusReasons, DAY_MS } from '@platform/core/domain'
import { ConversationsService } from '@platform/core/messaging'
import { ConversationSweep, LockNames, Schedules } from '@platform/core/queues'

import { LeaderLockService } from './leader-lock.service'
import { readInEachStore } from './store-sweep'
import { isNoLongerDue, runBatches, type SweepBatch } from './sweep-errors'

// rls-context: the stores, organizations and connections are listed from global tables or from a list of the database (WorkerLists);
// every read or write of a table of a store runs inside JobContext.forStore / forOrganization

const LOCK_SECONDS = 600

// Hourly, on one replica: a resolved conversation is archived once it has been resolved for the days
// its store chose (StoreSettings.autoArchiveAfterDays, TDD_09 §3). A customer who writes before that
// reopens it and clears the date, so only a conversation nobody came back to reaches here. Each run
// archives in batches, the oldest first.
@Injectable()
export class AutoArchiveScheduler {
  constructor(
    private readonly locks: LeaderLockService,
    private readonly prisma: PrismaService,
    private readonly conversations: ConversationsService,
    private readonly logger: PinoLogger,
    private readonly jobContext: JobContext
  ) {
    this.logger.setContext(AutoArchiveScheduler.name)
  }

  @Cron(Schedules.AUTO_ARCHIVE_RESOLVED)
  async run(): Promise<void> {
    try {
      await this.locks.withLock(LockNames.AUTO_ARCHIVE_RESOLVED, LOCK_SECONDS, async () => {
        const { changed, limited } = await runBatches(failed => this.archive(new Date(), failed))
        if (limited) {
          this.logger.warn(
            { archived: changed },
            'resolved conversations were archived up to the limit of a run; more may wait'
          )
        }
      })
    } catch (error) {
      // A cron that throws must not take the worker down; the next hour tries again
      this.logger.error(
        { errorName: errorName(error) },
        'the auto-archive of resolved conversations failed'
      )
    }
  }

  // One batch: how many conversations were due and how many of them were archived
  async archive(now: Date = new Date(), skip: Set<string> = new Set()): Promise<SweepBatch> {
    // The days are a setting of the store, so each store is read in its own context: its setting, then its resolved conversations
    const found = await readInEachStore(this.prisma, this.jobContext, async storeId => {
      const settings = await this.prisma.client.storeSettings.findUnique({
        where: { storeId },
        select: { autoArchiveAfterDays: true }
      })
      if (settings === null) return []
      const cutoff = new Date(now.getTime() - settings.autoArchiveAfterDays * DAY_MS)
      const rows = await this.prisma.client.conversation.findMany({
        where: {
          storeId,
          status: ConversationStatus.RESOLVED,
          resolvedAt: { lt: cutoff },
          id: { notIn: [...skip] }
        },
        select: { id: true, storeId: true, resolvedAt: true },
        orderBy: [{ resolvedAt: 'asc' }, { id: 'asc' }],
        take: ConversationSweep.BATCH
      })
      return rows.map(row => ({ ...row, cutoff }))
    })
    // The oldest of all the groups first, so that a group with a long backlog holds back no other
    const due = found
      .sort((a, b) => (a.resolvedAt?.getTime() ?? 0) - (b.resolvedAt?.getTime() ?? 0))
      .slice(0, ConversationSweep.BATCH)
    let archived = 0
    for (const { id, storeId, cutoff } of due) {
      try {
        await this.jobContext.forStore(storeId, () =>
          this.prisma.transaction(tx =>
            this.conversations.applyStatus(tx, storeId, id, ConversationStatus.ARCHIVED, {
              actor: 'system',
              reason: ConversationStatusReasons.AUTO_ARCHIVED,
              onlyIfDue: { status: ConversationStatus.RESOLVED, by: cutoff }
            })
          )
        )
        archived += 1
      } catch (error) {
        skip.add(id)
        // A person who got there first is the normal case, not a fault
        if (isNoLongerDue(error)) continue
        this.logger.warn(
          { conversationId: id, storeId, errorName: errorName(error) },
          'a resolved conversation could not be archived; the next run tries again'
        )
      }
    }
    return { fetched: due.length, changed: archived }
  }
}
