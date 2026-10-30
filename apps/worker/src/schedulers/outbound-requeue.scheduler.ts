import { Injectable } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import { PinoLogger } from 'nestjs-pino'

import { errorName } from '@platform/channels/connections'
import { PrismaService } from '@platform/core/database'
import { AuthorType, DeliveryStatus, OutboundLimits } from '@platform/core/domain'
import { ErrorCodes } from '@platform/core/errors'
import { OutboundQueue } from '@platform/core/messaging'
import { LockNames, Schedules } from '@platform/core/queues'

import { MessageChangeStatusWriter } from '../outbound/message-change-status.writer'
import { MessageStatusWriter } from '../outbound/message-status.writer'
import { ReactionStatusWriter } from '../outbound/reaction-status.writer'

import { LeaderLockService } from './leader-lock.service'

// A little under the interval of the schedule, as the lock of the health round is
const LOCK_SECONDS = 50

// The api queues a reply after it commits. If Redis was down at that moment the reply stays `queued`
// with no job, and nothing else would ever look at it: this does, once a minute. A reply that has a
// job (waiting, delayed or active) is left alone by the queue, so a slow send is not sent twice. One
// that has waited more than an hour is not sent late: it is marked failed. The reactions of agents
// are swept the same way, so that one the channel never got shows as failed and not as sending.
@Injectable()
export class OutboundRequeueScheduler {
  constructor(
    private readonly locks: LeaderLockService,
    private readonly prisma: PrismaService,
    private readonly outbound: OutboundQueue,
    private readonly status: MessageStatusWriter,
    private readonly reactionStatus: ReactionStatusWriter,
    private readonly changeStatus: MessageChangeStatusWriter,
    private readonly logger: PinoLogger
  ) {
    this.logger.setContext(OutboundRequeueScheduler.name)
  }

  @Cron(Schedules.REQUEUE_OUTBOUND)
  async run(): Promise<void> {
    try {
      await this.locks.withLock(LockNames.REQUEUE_OUTBOUND, LOCK_SECONDS, async () => {
        // Each sweep has its own way out: one that fails does not hide the other
        await this.sweep('replies', () => this.requeueStale())
        await this.sweep('reactions', () => this.requeueStaleReactions())
        await this.sweep('changes', () => this.requeueStaleChanges())
      })
    } catch (error) {
      // A cron that throws must not take the worker down; the next minute tries again
      this.logger.error({ errorName: errorName(error) }, 'the outbound sweep failed')
    }
  }

  private async sweep(
    what: 'replies' | 'reactions' | 'changes',
    run: () => Promise<{ requeued: number; gaveUp: number }>
  ): Promise<void> {
    try {
      const { requeued, gaveUp } = await run()
      if (requeued + gaveUp > 0) {
        this.logger.warn({ requeued, gaveUp }, `stale ${what} queued again or given up`)
      }
    } catch (error) {
      this.logger.error({ errorName: errorName(error) }, `the sweep of the ${what} failed`)
    }
  }

  async requeueStale(now: Date = new Date()): Promise<{ requeued: number; gaveUp: number }> {
    const staleBefore = new Date(now.getTime() - OutboundLimits.REQUEUE_AFTER_MS)
    const stale = await this.prisma.client.message.findMany({
      where: {
        deliveryStatus: DeliveryStatus.QUEUED,
        // A reply sent again is as old as the moment it was asked for again, not as its first attempt
        OR: [{ resentAt: null, createdAt: { lt: staleBefore } }, { resentAt: { lt: staleBefore } }]
      },
      select: { id: true, storeId: true, createdAt: true, resentAt: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: OutboundLimits.REQUEUE_BATCH
    })
    const giveUpBefore = now.getTime() - OutboundLimits.GIVE_UP_AFTER_MS
    const done = { requeued: 0, gaveUp: 0 }
    for (const { id, storeId, createdAt, resentAt } of stale) {
      // One reply that cannot be handled must not stop the ones behind it: the batch is the oldest
      // first, so the same one would block the sweep every minute
      try {
        if ((resentAt ?? createdAt).getTime() < giveUpBefore) {
          await this.status.apply({
            storeId,
            messageId: id,
            to: DeliveryStatus.FAILED,
            errorCode: ErrorCodes.CHANNEL_MESSAGE_FAILED
          })
          done.gaveUp += 1
        } else {
          await this.outbound.requeue({ storeId, messageId: id })
          done.requeued += 1
        }
      } catch (error) {
        this.logger.error(
          { messageId: id, errorName: errorName(error) },
          'a stale reply was not handled'
        )
      }
    }
    return done
  }

  // The time of a reaction is its version: it moves only when the agent sets it again, so a reaction
  // that is still queued and old is one whose job was lost
  async requeueStaleReactions(
    now: Date = new Date()
  ): Promise<{ requeued: number; gaveUp: number }> {
    const stale = await this.prisma.client.messageReaction.findMany({
      where: {
        authorType: AuthorType.AGENT,
        deliveryStatus: DeliveryStatus.QUEUED,
        userId: { not: null },
        updatedAt: { lt: new Date(now.getTime() - OutboundLimits.REQUEUE_AFTER_MS) }
      },
      select: { storeId: true, messageId: true, userId: true, updatedAt: true },
      orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
      take: OutboundLimits.REQUEUE_BATCH
    })
    const giveUpBefore = now.getTime() - OutboundLimits.GIVE_UP_AFTER_MS
    const done = { requeued: 0, gaveUp: 0 }
    for (const { storeId, messageId, userId, updatedAt } of stale) {
      if (userId === null) continue
      try {
        if (updatedAt.getTime() < giveUpBefore) {
          await this.reactionStatus.settle({
            storeId,
            messageId,
            userId,
            errorCode: ErrorCodes.CHANNEL_MESSAGE_FAILED,
            expectedVersion: updatedAt
          })
          done.gaveUp += 1
        } else {
          await this.outbound.requeueReaction({
            storeId,
            messageId,
            userId,
            version: updatedAt.getTime()
          })
          done.requeued += 1
        }
      } catch (error) {
        this.logger.error(
          { messageId, errorName: errorName(error) },
          'a stale reaction was not handled'
        )
      }
    }
    return done
  }

  // The edits and deletions of agents are swept the same way: the time of the request says when the job
  // was lost, and one that waited more than an hour shows as failed and not as sending
  async requeueStaleChanges(now: Date = new Date()): Promise<{ requeued: number; gaveUp: number }> {
    const staleBefore = new Date(now.getTime() - OutboundLimits.REQUEUE_AFTER_MS)
    const stale = await this.prisma.client.message.findMany({
      where: {
        changeRequestedAt: { lt: staleBefore },
        OR: [
          { editStatus: DeliveryStatus.QUEUED, pendingContent: { not: null } },
          { deleteStatus: DeliveryStatus.QUEUED }
        ]
      },
      select: {
        id: true,
        storeId: true,
        version: true,
        pendingContent: true,
        editStatus: true,
        deleteStatus: true,
        changeRequestedAt: true
      },
      orderBy: [{ changeRequestedAt: 'asc' }, { id: 'asc' }],
      take: OutboundLimits.REQUEUE_BATCH
    })
    const giveUpBefore = now.getTime() - OutboundLimits.GIVE_UP_AFTER_MS
    const done = { requeued: 0, gaveUp: 0 }
    for (const message of stale) {
      const { id: messageId, storeId, version } = message
      const gaveUp = (message.changeRequestedAt?.getTime() ?? 0) < giveUpBefore
      try {
        if (
          message.editStatus === DeliveryStatus.QUEUED.valueOf() &&
          message.pendingContent !== null
        ) {
          if (gaveUp) {
            await this.changeStatus.settleEdit({
              storeId,
              messageId,
              pendingContent: message.pendingContent,
              errorCode: ErrorCodes.CHANNEL_MESSAGE_FAILED
            })
          } else {
            await this.outbound.requeueEdit({ storeId, messageId, version })
          }
        }
        if (message.deleteStatus === DeliveryStatus.QUEUED.valueOf()) {
          if (gaveUp) {
            await this.changeStatus.settleDeletion({
              storeId,
              messageId,
              errorCode: ErrorCodes.CHANNEL_MESSAGE_FAILED
            })
          } else {
            await this.outbound.requeueDelete({ storeId, messageId, version })
          }
        }
        done[gaveUp ? 'gaveUp' : 'requeued'] += 1
      } catch (error) {
        this.logger.error(
          { messageId, errorName: errorName(error) },
          'a stale edit or deletion was not handled'
        )
      }
    }
    return done
  }
}
