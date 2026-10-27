import { Injectable } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import { PinoLogger } from 'nestjs-pino'

import { errorName } from '@platform/channels/connections'
import { PrismaService } from '@platform/core/database'
import { DeliveryStatus, OutboundLimits } from '@platform/core/domain'
import { ErrorCodes } from '@platform/core/errors'
import { OutboundQueue } from '@platform/core/messaging'
import { LockNames, Schedules } from '@platform/core/queues'

import { MessageStatusWriter } from '../outbound/message-status.writer'

import { LeaderLockService } from './leader-lock.service'

// A little under the interval of the schedule, as the lock of the health round is
const LOCK_SECONDS = 50

// The api queues a reply after it commits. If Redis was down at that moment the reply stays `queued`
// with no job, and nothing else would ever look at it: this does, once a minute. A reply that has a
// job (waiting, delayed or active) is left alone by the queue, so a slow send is not sent twice. One
// that has waited more than an hour is not sent late: it is marked failed.
@Injectable()
export class OutboundRequeueScheduler {
  constructor(
    private readonly locks: LeaderLockService,
    private readonly prisma: PrismaService,
    private readonly outbound: OutboundQueue,
    private readonly status: MessageStatusWriter,
    private readonly logger: PinoLogger
  ) {
    this.logger.setContext(OutboundRequeueScheduler.name)
  }

  @Cron(Schedules.REQUEUE_OUTBOUND)
  async run(): Promise<void> {
    try {
      await this.locks.withLock(LockNames.REQUEUE_OUTBOUND, LOCK_SECONDS, async () => {
        const { requeued, gaveUp } = await this.requeueStale()
        if (requeued + gaveUp > 0) {
          this.logger.warn({ requeued, gaveUp }, 'stale replies queued again or given up')
        }
      })
    } catch (error) {
      // A cron that throws must not take the worker down; the next minute tries again
      this.logger.error({ errorName: errorName(error) }, 'the outbound sweep failed')
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
}
