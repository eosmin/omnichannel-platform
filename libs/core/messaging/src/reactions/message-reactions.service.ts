import { Injectable } from '@nestjs/common'
import { PinoLogger } from 'nestjs-pino'

import { type PrismaTransaction, PrismaService } from '@platform/core/database'
import {
  AuthorType,
  DeliveryStatus,
  type ReactionActor,
  ReactionActors,
  safeText
} from '@platform/core/domain'
import { DomainEvents } from '@platform/core/event-bus'
import { Events } from '@platform/core/events'

import { isHiddenStatus } from '../conversations/conversations.support'
import { InboundMessageTargets } from '../inbound/inbound-message-targets'

// Who left a reaction: the customer by identity, an agent by user, the owner of the provider's own
// app by neither (there is one of them per message)
export type Reactor =
  | { authorType: AuthorType.CUSTOMER; customerIdentityId: string }
  | { authorType: AuthorType.AGENT; userId: string }
  | { authorType: AuthorType.EXTERNAL }

export interface InboundReaction {
  connectionId: string
  channelIdentity: string
  reaction: { targetExternalId: string; emoji: string | null; from?: ReactionActor | undefined }
}

export const ReactionOutcomes = {
  APPLIED: 'applied',
  IGNORED: 'ignored'
} as const
export type ReactionOutcome = (typeof ReactionOutcomes)[keyof typeof ReactionOutcomes]

const keyOf = (reactor: Reactor): Record<string, string | null> => ({
  customerIdentityId:
    reactor.authorType === AuthorType.CUSTOMER ? reactor.customerIdentityId : null,
  userId: reactor.authorType === AuthorType.AGENT ? reactor.userId : null
})

// The reactions of a message: one emoji for each person, a new one replaces the old, and none takes it
// back. The same writer serves the reactions a channel reports and, when agents react, the api.
@Injectable()
export class MessageReactionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly targets: InboundMessageTargets,
    private readonly events: DomainEvents,
    private readonly logger: PinoLogger
  ) {
    this.logger.setContext(MessageReactionsService.name)
  }

  // A reaction is never what opens a customer: if the handle is not known, or the message it points at
  // is not in a thread of that handle on that connection, there is nothing to attach it to and it is
  // dropped. It does not count as unread, reopen, or route a conversation.
  //
  // The message, or the customer, may not be stored yet (the events of a handle are not ordered): until
  // the last attempt it throws, so that the queue tries again, like the echo does. Known limit: a
  // reaction that is retried can land after the removal that followed it.
  async handleInbound(
    pluginId: string,
    event: InboundReaction,
    isLastAttempt: boolean
  ): Promise<ReactionOutcome> {
    const applied = await this.targets.apply(
      pluginId,
      { ...event, targetExternalId: event.reaction.targetExternalId },
      'reaction',
      isLastAttempt,
      async (tx, target) => {
        const reactor: Reactor =
          event.reaction.from === ReactionActors.EXTERNAL
            ? { authorType: AuthorType.EXTERNAL }
            : { authorType: AuthorType.CUSTOMER, customerIdentityId: target.customerIdentityId }
        await this.set(tx, target.storeId, target.messageId, reactor, event.reaction.emoji)
      }
    )
    if (!applied) this.logger.debug({ pluginId }, 'reaction for a message that is not here')
    return applied ? ReactionOutcomes.APPLIED : ReactionOutcomes.IGNORED
  }

  // Puts the reaction of `reactor` on a message of the store, or takes it back with a null emoji, and
  // tells the team. The caller holds the store lock and has checked that the message may be reacted to.
  // `delivery` is where the reaction stands toward the channel: the ones a channel reports are already
  // there (sent); an agent's starts queued. Returns when it changed something (an emoji, or a refused one
  // sent again), or null when it did not: a repeated webhook, or a repeated click on one that is waiting
  // or was sent.
  async set(
    tx: PrismaTransaction,
    storeId: string,
    messageId: string,
    reactor: Reactor,
    emoji: string | null,
    delivery: DeliveryStatus = DeliveryStatus.SENT
  ): Promise<Date | null> {
    // Before anything is written: the row carries the store of the caller, and nothing ties it to the
    // store of the message but this look
    const message = await tx.message.findFirst({
      where: { id: messageId, storeId },
      select: {
        conversationId: true,
        conversation: { select: { status: true, assignedTo: true } }
      }
    })
    if (message === null) return null
    // Set here so that the caller can name this change (the job of an agent's reaction carries it)
    const now = new Date()
    const clean = emoji === null ? '' : safeText(emoji)
    const key = keyOf(reactor)
    const where = { storeId, messageId, authorType: reactor.authorType, ...key }
    let changed: boolean
    if (clean === '') {
      changed = (await tx.messageReaction.deleteMany({ where })).count > 0
    } else {
      const existing = await tx.messageReaction.findFirst({
        where,
        select: { emoji: true, deliveryStatus: true }
      })
      // The same emoji is a change only to send again what the channel refused; a waiting or a sent one
      // is left as it is, so that a repeated click never sends it twice
      changed =
        existing === null ||
        existing.emoji !== clean ||
        (existing.deliveryStatus === DeliveryStatus.FAILED.valueOf() &&
          delivery !== DeliveryStatus.FAILED)
      if (existing === null) {
        await tx.messageReaction.create({
          data: {
            storeId,
            messageId,
            authorType: reactor.authorType,
            emoji: clean,
            deliveryStatus: delivery,
            updatedAt: now,
            ...key
          }
        })
      } else if (changed) {
        await tx.messageReaction.updateMany({
          where,
          data: { emoji: clean, deliveryStatus: delivery, deliveryError: null, updatedAt: now }
        })
      }
    }
    // A redelivered webhook or a repeated emoji changes nothing, and nobody needs to hear of it
    if (!changed) return null
    this.events.publish(tx, Events.MESSAGE_REACTION, {
      storeId,
      conversationId: message.conversationId,
      messageId,
      visibility: {
        hidden: isHiddenStatus(message.conversation.status),
        assignedTo: message.conversation.assignedTo
      }
    })
    return now
  }
}
