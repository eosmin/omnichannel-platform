import { Injectable } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import { PinoLogger } from 'nestjs-pino'

import { errorName } from '@platform/channels/connections'
import { JobContext, PrismaService } from '@platform/core/database'
import { AuthorType, CaptionState, DeliveryStatus, OutboundLimits } from '@platform/core/domain'
import { ErrorCodes } from '@platform/core/errors'
import { OutboundQueue } from '@platform/core/messaging'
import { LockNames, Schedules } from '@platform/core/queues'

import { MessageChangeStatusWriter } from '../outbound/message-change-status.writer'
import { MessageStatusWriter } from '../outbound/message-status.writer'
import { ReactionStatusWriter } from '../outbound/reaction-status.writer'

import { LeaderLockService } from './leader-lock.service'
import { readInEachStore } from './store-sweep'

// rls-context: the stores, organizations and connections are listed from global tables or from a list of the database (WorkerLists);
// every read or write of a table of a store runs inside JobContext.forStore / forOrganization

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
    private readonly logger: PinoLogger,
    private readonly jobContext: JobContext
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
    const found = await readInEachStore(
      this.prisma,
      this.jobContext,
      storeId =>
        this.prisma.client.message.findMany({
          where: {
            storeId,
            deliveryStatus: DeliveryStatus.QUEUED,
            // A reply sent again is as old as the moment it was asked for again, not as its first attempt
            OR: [
              { resentAt: null, createdAt: { lt: staleBefore } },
              { resentAt: { lt: staleBefore } }
            ]
          },
          select: { id: true, storeId: true, createdAt: true, resentAt: true },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          take: OutboundLimits.REQUEUE_BATCH
        }),
      (storeId, error) =>
        this.logger.error({ storeId, errorName: errorName(error) }, 'a store could not be swept')
    )
    // The oldest of every store first, as one batch: the work of a store is not held back by another's
    const stale = found
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : 1))
      .slice(0, OutboundLimits.REQUEUE_BATCH)
    const giveUpBefore = now.getTime() - OutboundLimits.GIVE_UP_AFTER_MS
    const done = { requeued: 0, gaveUp: 0 }
    for (const { id, storeId, createdAt, resentAt } of stale) {
      // One reply that cannot be handled must not stop the ones behind it: the batch is the oldest
      // first, so the same one would block the sweep every minute
      try {
        if ((resentAt ?? createdAt).getTime() < giveUpBefore) {
          await this.jobContext.forStore(storeId, () =>
            this.status.apply({
              storeId,
              messageId: id,
              to: DeliveryStatus.FAILED,
              errorCode: ErrorCodes.CHANNEL_MESSAGE_FAILED
            })
          )
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
    const found = await readInEachStore(
      this.prisma,
      this.jobContext,
      storeId =>
        this.prisma.client.messageReaction.findMany({
          where: {
            storeId,
            // A person's reaction, or a plugin's (the system's, with the plugin's id)
            OR: [
              { authorType: AuthorType.AGENT, userId: { not: null } },
              { authorType: AuthorType.SYSTEM, pluginId: { not: null } }
            ],
            deliveryStatus: DeliveryStatus.QUEUED,
            updatedAt: { lt: new Date(now.getTime() - OutboundLimits.REQUEUE_AFTER_MS) }
          },
          select: {
            storeId: true,
            messageId: true,
            userId: true,
            pluginId: true,
            mediaId: true,
            updatedAt: true
          },
          orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
          take: OutboundLimits.REQUEUE_BATCH
        }),
      (storeId, error) =>
        this.logger.error({ storeId, errorName: errorName(error) }, 'a store could not be swept')
    )
    const stale = found
      .sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime())
      .slice(0, OutboundLimits.REQUEUE_BATCH)
    const giveUpBefore = now.getTime() - OutboundLimits.GIVE_UP_AFTER_MS
    const done = { requeued: 0, gaveUp: 0 }
    for (const { storeId, messageId, userId, pluginId, mediaId, updatedAt } of stale) {
      if (userId === null && pluginId === null) continue
      const by = pluginId === null ? { userId } : { userId: null, pluginId }
      try {
        if (updatedAt.getTime() < giveUpBefore) {
          await this.jobContext.forStore(storeId, () =>
            this.reactionStatus.settle({
              storeId,
              messageId,
              ...by,
              mediaId,
              errorCode: ErrorCodes.CHANNEL_MESSAGE_FAILED,
              expectedVersion: updatedAt
            })
          )
          done.gaveUp += 1
        } else {
          await this.outbound.requeueReaction({
            storeId,
            messageId,
            ...by,
            version: updatedAt.getTime(),
            ...(mediaId === null ? {} : { mediaId })
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

  // The edits, deletions and resent captions of agents are swept the same way: the time of the request says when the job
  // was lost, and one that waited more than an hour shows as failed and not as sending
  async requeueStaleChanges(now: Date = new Date()): Promise<{ requeued: number; gaveUp: number }> {
    const staleBefore = new Date(now.getTime() - OutboundLimits.REQUEUE_AFTER_MS)
    const found = await readInEachStore(
      this.prisma,
      this.jobContext,
      storeId =>
        this.prisma.client.message.findMany({
          where: {
            storeId,
            changeRequestedAt: { lt: staleBefore },
            OR: [
              { editStatus: DeliveryStatus.QUEUED, pendingContent: { not: null } },
              { deleteStatus: DeliveryStatus.QUEUED },
              { captionState: CaptionState.QUEUED }
            ]
          },
          select: {
            id: true,
            storeId: true,
            version: true,
            pendingContent: true,
            editStatus: true,
            deleteStatus: true,
            captionState: true,
            changeRequestedAt: true
          },
          orderBy: [{ changeRequestedAt: 'asc' }, { id: 'asc' }],
          take: OutboundLimits.REQUEUE_BATCH
        }),
      (storeId, error) =>
        this.logger.error({ storeId, errorName: errorName(error) }, 'a store could not be swept')
    )
    const stale = found
      .sort((a, b) => (a.changeRequestedAt?.getTime() ?? 0) - (b.changeRequestedAt?.getTime() ?? 0))
      .slice(0, OutboundLimits.REQUEUE_BATCH)
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
          const { pendingContent } = message
          if (gaveUp) {
            await this.jobContext.forStore(storeId, () =>
              this.changeStatus.settleEdit({
                storeId,
                messageId,
                pendingContent,
                errorCode: ErrorCodes.CHANNEL_MESSAGE_FAILED
              })
            )
          } else {
            await this.outbound.requeueEdit({ storeId, messageId, version })
          }
        }
        if (message.deleteStatus === DeliveryStatus.QUEUED.valueOf()) {
          if (gaveUp) {
            await this.jobContext.forStore(storeId, () =>
              this.changeStatus.settleDeletion({
                storeId,
                messageId,
                errorCode: ErrorCodes.CHANNEL_MESSAGE_FAILED
              })
            )
          } else {
            await this.outbound.requeueDelete({ storeId, messageId, version })
          }
        }
        if (message.captionState === CaptionState.QUEUED.valueOf()) {
          // Never queued again: a job that sent the text and could not write it down looks the same as
          // a job that was lost, and sending twice is worse than saying to check the chat. Both end
          // `unconfirmed` once the request is old enough to have had its job.
          await this.jobContext.forStore(storeId, () =>
            this.changeStatus.settleCaption({
              storeId,
              messageId,
              version,
              outcome: { state: CaptionState.UNCONFIRMED }
            })
          )
          done.gaveUp += 1
          continue
        }
        done[gaveUp ? 'gaveUp' : 'requeued'] += 1
      } catch (error) {
        this.logger.error(
          { messageId, errorName: errorName(error) },
          'a stale edit, deletion or caption was not handled'
        )
      }
    }
    return done
  }
}
