import { Injectable } from '@nestjs/common'

import { PrismaService } from '@platform/core/database'
import { AuthorType, DeliveryStatus } from '@platform/core/domain'
import type { ErrorCode } from '@platform/core/errors'
import { DomainEvents } from '@platform/core/event-bus'
import { Events } from '@platform/core/events'
import { addRevision, lockMessageRow, publishMessageChanged } from '@platform/core/messaging'

export interface EditSettlement {
  storeId: string
  messageId: string
  // The text the job sent: the settlement applies only to the request that still holds it
  pendingContent: string
  // null: the channel took it
  errorCode: ErrorCode | null
}

export interface DeletionSettlement {
  storeId: string
  messageId: string
  errorCode: ErrorCode | null
}

// The one writer of what becomes of an agent's edit or deletion once the channel answered. An edit the
// channel took replaces the text and keeps the old one as a revision; one it refused leaves the text as
// it was and says why. A deletion the channel took hides the message; one it refused leaves it shown.
// Both name the state they expect, so a late job never settles a request that was made again.
@Injectable()
export class MessageChangeStatusWriter {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: DomainEvents
  ) {}

  async settleEdit(settlement: EditSettlement): Promise<void> {
    const { storeId, messageId, pendingContent, errorCode } = settlement
    await this.prisma.transaction(async tx => {
      await lockMessageRow(tx, messageId)
      const current = await tx.message.findFirst({
        where: {
          id: messageId,
          storeId,
          editStatus: DeliveryStatus.QUEUED,
          pendingContent
        },
        select: { content: true, authorId: true, deletedAt: true }
      })
      if (current === null) return
      // A message deleted since the agent asked is not edited: the request is dropped
      if (current.deletedAt !== null) {
        await tx.message.update({
          where: { id: messageId },
          data: { pendingContent: null, editStatus: null, changeRequestedAt: null }
        })
        return
      }
      if (errorCode === null) {
        await addRevision(tx, {
          storeId,
          messageId,
          content: current.content,
          editedByType: AuthorType.AGENT,
          editedById: current.authorId
        })
      }
      await tx.message.update({
        where: { id: messageId },
        data:
          errorCode === null
            ? {
                content: pendingContent,
                pendingContent: null,
                editStatus: DeliveryStatus.SENT,
                editError: null,
                editedAt: new Date(),
                editedByType: AuthorType.AGENT,
                editedById: current.authorId,
                changeRequestedAt: null
              }
            : {
                pendingContent: null,
                editStatus: DeliveryStatus.FAILED,
                editError: errorCode,
                changeRequestedAt: null
              }
      })
      await publishMessageChanged(this.events, tx, Events.MESSAGE_EDITED, storeId, messageId)
    })
  }

  async settleDeletion(settlement: DeletionSettlement): Promise<void> {
    const { storeId, messageId, errorCode } = settlement
    await this.prisma.transaction(async tx => {
      await lockMessageRow(tx, messageId)
      const changed = await tx.message.updateMany({
        where: { id: messageId, storeId, deleteStatus: DeliveryStatus.QUEUED },
        data:
          errorCode === null
            ? {
                deletedAt: new Date(),
                deleteStatus: DeliveryStatus.SENT,
                deleteError: null,
                changeRequestedAt: null
              }
            : {
                changeRequestedAt: null,
                deleteStatus: DeliveryStatus.FAILED,
                deleteError: errorCode,
                // Nobody deleted it
                deletedByType: null,
                deletedById: null
              }
      })
      if (changed.count === 0) return
      await publishMessageChanged(this.events, tx, Events.MESSAGE_DELETED, storeId, messageId)
    })
  }
}
