import { Injectable } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import { PinoLogger } from 'nestjs-pino'

import { errorName } from '@platform/channels/connections'
import { PrismaService } from '@platform/core/database'
import { AuthorType, DeliveryStatus, OutboundLimits } from '@platform/core/domain'
import { ErrorCodes } from '@platform/core/errors'
import { OutboundQueue } from '@platform/core/messaging'
import { LockNames, Schedules } from '@platform/core/queues'

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
      })
    } catch (error) {
      // A cron that throws must not take the worker down; the next minute tries again
      this.logger.error({ errorName: errorName(error) }, 'the outbound sweep failed')
    }
  }

  private async sweep(
    what: 'replies' | 'reactions',
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
    const stale = await this.prisma.client.message.findMany({
      where: {
        deliveryStatus: DeliveryStatus.QUEUED,
        createdAt: { lt: new Date(now.getTime() - OutboundLimits.REQUEUE_AFTER_MS) }
      },
      select: { id: true, storeId: true, createdAt: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: OutboundLimits.REQUEUE_BATCH
    })
    const giveUpBefore = now.getTime() - OutboundLimits.GIVE_UP_AFTER_MS
    const done = { requeued: 0, gaveUp: 0 }
    for (const { id, storeId, createdAt } of stale) {
      // One reply that cannot be handled must not stop the ones behind it: the batch is the oldest
      // first, so the same one would block the sweep every minute
      try {
        if (createdAt.getTime() < giveUpBefore) {
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
}
