import { Injectable } from '@nestjs/common'

import { PrismaService } from '@platform/core/database'
import { ChannelResultMetadata, DeliveryStatus } from '@platform/core/domain'
import { ErrorCodes, type ErrorCode } from '@platform/core/errors'
import { DomainEvents } from '@platform/core/event-bus'
import { Events } from '@platform/core/events'
import { isHiddenStatus } from '@platform/core/messaging'

// A state is reached only from the ones before it: a late or repeated receipt never takes a message
// back (read does not become delivered again), and a failure does not undo what the customer saw.
const REACHABLE_FROM: Readonly<
  Record<Exclude<DeliveryStatus, DeliveryStatus.QUEUED>, DeliveryStatus[]>
> = {
  [DeliveryStatus.SENT]: [DeliveryStatus.QUEUED],
  [DeliveryStatus.DELIVERED]: [DeliveryStatus.QUEUED, DeliveryStatus.SENT],
  [DeliveryStatus.READ]: [DeliveryStatus.QUEUED, DeliveryStatus.SENT, DeliveryStatus.DELIVERED],
  [DeliveryStatus.FAILED]: [DeliveryStatus.QUEUED, DeliveryStatus.SENT]
}

export interface StatusChange {
  storeId: string
  messageId: string
  to: Exclude<DeliveryStatus, DeliveryStatus.QUEUED>
  // The provider's id, written when the channel takes the message
  channelMessageId?: string
  // The id of the second message that carried the caption of a file (`ChannelResultMetadata`), kept
  // so that the echo of that message is not stored again as the owner's
  captionExternalId?: string
  // Only for FAILED: a code of ours, never the provider's words
  errorCode?: ErrorCode
}

// The one writer of the delivery state of a reply, for the processor that sends it and for the
// receipts of the provider. The write names the states it expects, so two writers racing end in one
// event, not two.
@Injectable()
export class MessageStatusWriter {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: DomainEvents
  ) {}

  // true when this call made the change
  async apply(change: StatusChange): Promise<boolean> {
    const { storeId, messageId, to } = change
    return this.prisma.transaction(async tx => {
      const changed = await tx.message.updateMany({
        where: { id: messageId, storeId, deliveryStatus: { in: REACHABLE_FROM[to] } },
        data: {
          deliveryStatus: to,
          ...(change.channelMessageId === undefined
            ? {}
            : { channelMessageId: change.channelMessageId }),
          ...(change.captionExternalId === undefined
            ? {}
            : {
                metadata: { [ChannelResultMetadata.CAPTION_EXTERNAL_ID]: change.captionExternalId }
              }),
          deliveryError: to === DeliveryStatus.FAILED ? (change.errorCode ?? null) : null
        }
      })
      if (changed.count === 0) return false

      const message = await tx.message.findFirst({
        where: { id: messageId, storeId },
        select: {
          conversationId: true,
          conversation: { select: { status: true, assignedTo: true } }
        }
      })
      if (message === null) return true
      const payload = {
        storeId,
        conversationId: message.conversationId,
        messageId,
        visibility: {
          hidden: isHiddenStatus(message.conversation.status),
          assignedTo: message.conversation.assignedTo
        }
      }
      switch (to) {
        case DeliveryStatus.SENT:
          this.events.publish(tx, Events.MESSAGE_SENT, payload)
          break
        case DeliveryStatus.DELIVERED:
          this.events.publish(tx, Events.MESSAGE_DELIVERED, payload)
          break
        case DeliveryStatus.READ:
          this.events.publish(tx, Events.MESSAGE_READ, payload)
          break
        case DeliveryStatus.FAILED:
          this.events.publish(tx, Events.MESSAGE_FAILED, {
            ...payload,
            errorCode: change.errorCode ?? ErrorCodes.CHANNEL_MESSAGE_FAILED
          })
          break
      }
      return true
    })
  }
}
