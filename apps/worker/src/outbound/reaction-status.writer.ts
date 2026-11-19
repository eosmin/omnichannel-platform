// rls-context: every database access of this file runs inside a JobContext (forStore, or forUser for an avatar) opened around that one call; the provider, the bucket and the scanner are called outside of it
import { Injectable } from '@nestjs/common'

import { JobContext, PrismaService } from '@platform/core/database'
import { DeliveryStatus } from '@platform/core/domain'
import type { ErrorCode } from '@platform/core/errors'
import { DomainEvents } from '@platform/core/event-bus'
import { Events } from '@platform/core/events'
import { isHiddenStatus, reactionWhereOf, reactorOfJob } from '@platform/core/messaging'

export interface ReactionSettlement {
  storeId: string
  messageId: string
  // The person that reacted, or null when a plugin did (`pluginId`)
  userId: string | null
  pluginId?: string | undefined
  // The file the reaction is under; null: the message itself
  mediaId?: string | null | undefined
  // null: the channel took it
  errorCode: ErrorCode | null
  // `updatedAt` of the reaction the job read; null when the job took a reaction back, which has no row
  expectedVersion: Date | null
}

// The one writer of the delivery state of an agent's reaction. It names the state and the version it
// expects, so a late job never settles a reaction that was set again after it.
@Injectable()
export class ReactionStatusWriter {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: DomainEvents,
    private readonly jobContext: JobContext
  ) {}

  async settle(settlement: ReactionSettlement): Promise<void> {
    const { storeId, messageId, errorCode, expectedVersion } = settlement
    const reactor = reactorOfJob(settlement)
    const mediaId = settlement.mediaId ?? null
    // A reaction taken back has no row to mark: the team already saw it go
    if (expectedVersion === null) return
    await this.jobContext.forStore(storeId, () =>
      this.prisma.transaction(async tx => {
        const changed = await tx.messageReaction.updateMany({
          where: {
            ...reactionWhereOf(reactor),
            storeId,
            messageId,
            mediaId,
            deliveryStatus: DeliveryStatus.QUEUED,
            updatedAt: expectedVersion
          },
          data: {
            deliveryStatus: errorCode === null ? DeliveryStatus.SENT : DeliveryStatus.FAILED,
            deliveryError: errorCode,
            // The version stays: no job is waiting for this state to change
            updatedAt: expectedVersion
          }
        })
        if (changed.count === 0) return
        const message = await tx.message.findFirst({
          where: { id: messageId, storeId },
          select: {
            conversationId: true,
            conversation: { select: { status: true, assignedTo: true } }
          }
        })
        if (message === null) return
        this.events.publish(tx, Events.MESSAGE_REACTION, {
          storeId,
          conversationId: message.conversationId,
          messageId,
          visibility: {
            hidden: isHiddenStatus(message.conversation.status),
            assignedTo: message.conversation.assignedTo
          }
        })
      })
    )
  }
}
