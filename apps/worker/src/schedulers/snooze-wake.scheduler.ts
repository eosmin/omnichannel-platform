import { Injectable } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import { PinoLogger } from 'nestjs-pino'

import { errorName } from '@platform/channels/connections'
import { PrismaService } from '@platform/core/database'
import { ConversationStatus, ConversationStatusReasons } from '@platform/core/domain'
import { ConversationsService } from '@platform/core/messaging'
import { ConversationSweep, LockNames, Schedules } from '@platform/core/queues'

import { LeaderLockService } from './leader-lock.service'
import { isNoLongerDue, runBatches, type SweepBatch } from './sweep-errors'

// Room for the most a run can do (MAX_BATCHES of BATCH conversations); a replica that dies holds it
// for this long at most, and the next minutes' runs only wait
const LOCK_SECONDS = 300

// Every minute, on one replica: a snoozed conversation whose moment has passed goes back to open,
// with the line that it woke up and the event that tells its assignee (TDD_09 §3). The longest overdue
// go first, in batches.
@Injectable()
export class SnoozeWakeScheduler {
  constructor(
    private readonly locks: LeaderLockService,
    private readonly prisma: PrismaService,
    private readonly conversations: ConversationsService,
    private readonly logger: PinoLogger
  ) {
    this.logger.setContext(SnoozeWakeScheduler.name)
  }

  @Cron(Schedules.WAKE_SNOOZED)
  async run(): Promise<void> {
    try {
      await this.locks.withLock(LockNames.WAKE_SNOOZED, LOCK_SECONDS, async () => {
        const { changed, limited } = await runBatches(failed => this.wake(new Date(), failed))
        if (limited) {
          this.logger.warn(
            { woken: changed },
            'snoozed conversations woke up to the limit of a run; more may wait'
          )
        }
      })
    } catch (error) {
      // A cron that throws must not take the worker down; the next minute tries again
      this.logger.error({ errorName: errorName(error) }, 'the wake of snoozed conversations failed')
    }
  }

  // One batch: how many conversations were due and how many of them woke up
  async wake(now: Date = new Date(), skip: Set<string> = new Set()): Promise<SweepBatch> {
    const due = await this.prisma.client.conversation.findMany({
      where: {
        status: ConversationStatus.SNOOZED,
        snoozedUntil: { lte: now },
        id: { notIn: [...skip] }
      },
      select: { id: true, storeId: true },
      orderBy: [{ snoozedUntil: 'asc' }, { id: 'asc' }],
      take: ConversationSweep.BATCH
    })
    let woken = 0
    for (const { id, storeId } of due) {
      try {
        // The row is locked and read again inside: one that a person woke, resolved or snoozed again
        // since the query is refused, and the next one goes on
        await this.prisma.transaction(tx =>
          this.conversations.applyStatus(tx, storeId, id, ConversationStatus.OPEN, {
            actor: 'system',
            reason: ConversationStatusReasons.SNOOZE_EXPIRED,
            onlyIfDue: { status: ConversationStatus.SNOOZED, by: now }
          })
        )
        woken += 1
      } catch (error) {
        skip.add(id)
        // A person who got there first is the normal case, not a fault
        if (isNoLongerDue(error)) continue
        this.logger.warn(
          { conversationId: id, storeId, errorName: errorName(error) },
          'a snoozed conversation could not be woken; the next run tries again'
        )
      }
    }
    return { fetched: due.length, changed: woken }
  }
}
