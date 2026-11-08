import { Injectable } from '@nestjs/common'

import { PrismaService } from '@platform/core/database'
import { AuthorType, CaptionState, DeliveryStatus } from '@platform/core/domain'
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

// The same for the text under ONE file of a message (`mediaId`): the request is the version of the message
export interface MediaCaptionSettlement extends CaptionSettlement {
  mediaId: string
}

export interface CaptionSettlement {
  storeId: string
  messageId: string
  // The `version` of the request the job carries: a late job never settles a request made again
  version: number
  // What the channel answered: `sent` with the id of the text, or a state that says it did not clearly go
  outcome:
    | { state: typeof CaptionState.SENT; externalId: string }
    | { state: typeof CaptionState.FAILED | typeof CaptionState.UNCONFIRMED }
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

  // The text under a file that an agent sent again: the channel took it (`sent`, with its id so that its
  // echo is not stored again), refused it (`failed`) or gave no clear answer (`unconfirmed`, settled by the
  // echo of the owner). It names the state it expects, so a late job never settles a request made again.
  async settleCaption(settlement: CaptionSettlement): Promise<void> {
    const { storeId, messageId, version, outcome } = settlement
    await this.prisma.transaction(async tx => {
      await lockMessageRow(tx, messageId)
      const changed = await tx.message.updateMany({
        where: { id: messageId, storeId, version, captionState: CaptionState.QUEUED },
        data: {
          captionState: outcome.state,
          changeRequestedAt: null,
          ...(outcome.state === CaptionState.SENT
            ? { captionChannelMessageId: outcome.externalId }
            : {})
        }
      })
      if (changed.count === 0) return
      await publishMessageChanged(this.events, tx, Events.MESSAGE_EDITED, storeId, messageId)
    })
  }

  async settleMediaCaption(settlement: MediaCaptionSettlement): Promise<void> {
    const { storeId, messageId, mediaId, version, outcome } = settlement
    await this.prisma.transaction(async tx => {
      await lockMessageRow(tx, messageId)
      // A request made again meanwhile has another version: a late job settles nothing
      const current = await tx.message.count({ where: { id: messageId, storeId, version } })
      if (current === 0) return
      const changed = await tx.media.updateMany({
        where: { id: mediaId, storeId, messageId, captionState: CaptionState.QUEUED },
        data: {
          captionState: outcome.state,
          ...(outcome.state === CaptionState.SENT
            ? { captionChannelMessageId: outcome.externalId }
            : {})
        }
      })
      if (changed.count === 0) return
      // The request is over unless another text of the message still waits
      const waiting = await tx.media.count({
        where: { storeId, messageId, captionState: CaptionState.QUEUED }
      })
      if (waiting === 0) {
        await tx.message.updateMany({
          where: { id: messageId, storeId },
          data: { changeRequestedAt: null }
        })
      }
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
