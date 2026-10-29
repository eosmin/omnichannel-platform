import { Injectable } from '@nestjs/common'

import { PrismaService } from '@platform/core/database'
import {
  AuthorType,
  DeliveryStatus,
  type ReactionActor,
  ReactionActors
} from '@platform/core/domain'
import { DomainEvents } from '@platform/core/event-bus'
import { Events } from '@platform/core/events'

import { InboundMessageTargets } from '../inbound/inbound-message-targets'

import { lockMessageRow, publishMessageChanged } from './message-changed'
import { addRevision } from './message-revisions'

interface InboundChange {
  connectionId: string
  channelIdentity: string
}

export interface InboundEdit extends InboundChange {
  edit: { targetExternalId: string; content: string; from?: ReactionActor | undefined }
}

export interface InboundDeletion extends InboundChange {
  deletion: { targetExternalId: string; from?: ReactionActor | undefined }
}

const actorOf = (from: ReactionActor | undefined): AuthorType =>
  from === ReactionActors.EXTERNAL ? AuthorType.EXTERNAL : AuthorType.CUSTOMER

// An edit or a deletion that the provider reports: made by the customer, or by the owner in the
// provider's own app. It is applied whoever wrote the message (the provider already decided it may
// be changed), and it never opens a customer, reopens a conversation or counts as unread.
@Injectable()
export class InboundMessageChangesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly targets: InboundMessageTargets,
    private readonly events: DomainEvents
  ) {}

  // The old text is kept as a revision. A message that is deleted, or already has that text, is left
  // alone, so that a redelivered webhook changes nothing.
  async handleEdited(pluginId: string, event: InboundEdit, isLastAttempt: boolean): Promise<void> {
    await this.targets.apply(
      pluginId,
      { ...event, targetExternalId: event.edit.targetExternalId },
      'edit',
      isLastAttempt,
      async (tx, { storeId, messageId }) => {
        await lockMessageRow(tx, messageId)
        const message = await tx.message.findFirst({
          where: { id: messageId, storeId },
          select: { content: true, deletedAt: true }
        })
        if (message === null || message.deletedAt !== null) return
        if (message.content === event.edit.content) return
        const by = actorOf(event.edit.from)
        await addRevision(tx, {
          storeId,
          messageId,
          content: message.content,
          editedByType: by,
          editedById: null
        })
        await tx.message.update({
          where: { id: messageId },
          data: {
            content: event.edit.content,
            version: { increment: 1 },
            editedAt: new Date(),
            editedByType: by,
            editedById: null,
            // What the provider now holds is the latest word: an edit of an agent that still waits would
            // overwrite it, so it is dropped
            pendingContent: null,
            editStatus: null,
            changeRequestedAt: null
          }
        })
        await publishMessageChanged(this.events, tx, Events.MESSAGE_EDITED, storeId, messageId)
      }
    )
  }

  // The message stays, as a tombstone: the thread shows that it was deleted and by whom, and the text is
  // kept for DeletedMessageRetention and then purged
  async handleDeleted(
    pluginId: string,
    event: InboundDeletion,
    isLastAttempt: boolean
  ): Promise<void> {
    await this.targets.apply(
      pluginId,
      { ...event, targetExternalId: event.deletion.targetExternalId },
      'deletion',
      isLastAttempt,
      async (tx, { storeId, messageId }) => {
        await lockMessageRow(tx, messageId)
        const message = await tx.message.findFirst({
          where: { id: messageId, storeId },
          select: { deletedAt: true, deleteStatus: true }
        })
        if (message === null || message.deletedAt !== null) return
        // The provider's echo of a deletion we asked for is that deletion taken, not another author's:
        // the agent who asked stays the one who deleted it
        const ours = message.deleteStatus === DeliveryStatus.QUEUED.valueOf()
        await tx.message.update({
          where: { id: messageId },
          data: {
            deletedAt: new Date(),
            ...(ours
              ? { deleteStatus: DeliveryStatus.SENT }
              : {
                  deletedByType: actorOf(event.deletion.from),
                  deletedById: null,
                  deleteStatus: null,
                  deleteError: null
                }),
            // Whatever of ours was still on its way to a deleted message is moot
            pendingContent: null,
            editStatus: null,
            changeRequestedAt: null
          }
        })
        await publishMessageChanged(this.events, tx, Events.MESSAGE_DELETED, storeId, messageId)
      }
    )
  }
}
