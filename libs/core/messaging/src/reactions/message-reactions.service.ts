import { Injectable } from '@nestjs/common'
import { PinoLogger } from 'nestjs-pino'

import {
  lockStoreForWrite,
  lockStoreScope,
  PrismaService,
  type PrismaTransaction
} from '@platform/core/database'
import { AuthorType, type ReactionActor, ReactionActors, safeText } from '@platform/core/domain'
import { DomainEvents } from '@platform/core/event-bus'
import { Events } from '@platform/core/events'

import { ChannelConnectionResolver } from '../channels/channel-connection.resolver'
import { isHiddenStatus } from '../conversations/conversations.support'
import { parseChannelIdentity } from '../customers/identity'

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
    private readonly connections: ChannelConnectionResolver,
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
    const connection = await this.connections.resolve(pluginId, event.connectionId)
    if (connection === null || !connection.active) return ReactionOutcomes.IGNORED
    const { storeId } = connection
    const parsed = parseChannelIdentity(pluginId, event.channelIdentity, { fromChannel: true })
    if (parsed === null) return ReactionOutcomes.IGNORED
    const identity = await this.prisma.client.customerIdentity.findFirst({
      where: { storeId, channelType: pluginId, channelIdentity: parsed.identity },
      select: { id: true }
    })
    if (identity === null) {
      // The message of that customer may be being stored right now, and makes the identity
      if (!isLastAttempt) throw new Error('the reaction came before the customer it is from')
      return ReactionOutcomes.IGNORED
    }

    const applied = await this.prisma.transaction(async tx => {
      await lockStoreForWrite(tx, storeId)
      // Takes turns with the messages of the same handle: the reaction may follow its message closely
      await lockStoreScope(tx, storeId, `inbound-${identity.id}`)
      const target = await tx.message.findFirst({
        where: {
          storeId,
          channelMessageId: event.reaction.targetExternalId,
          conversation: { customerIdentityId: identity.id, channelConnectionId: connection.id }
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: { id: true }
      })
      if (target === null) {
        if (!isLastAttempt) throw new Error('the reaction came before the message it points at')
        return false
      }
      const reactor: Reactor =
        event.reaction.from === ReactionActors.EXTERNAL
          ? { authorType: AuthorType.EXTERNAL }
          : { authorType: AuthorType.CUSTOMER, customerIdentityId: identity.id }
      await this.set(tx, storeId, target.id, reactor, event.reaction.emoji)
      return true
    })
    if (!applied) this.logger.debug({ pluginId }, 'reaction for a message that is not here')
    return applied ? ReactionOutcomes.APPLIED : ReactionOutcomes.IGNORED
  }

  // Puts the reaction of `reactor` on a message of the store, or takes it back with a null emoji, and
  // tells the team. The caller holds the store lock and has checked that the message may be reacted to.
  async set(
    tx: PrismaTransaction,
    storeId: string,
    messageId: string,
    reactor: Reactor,
    emoji: string | null
  ): Promise<void> {
    // Before anything is written: the row carries the store of the caller, and nothing ties it to the
    // store of the message but this look
    const message = await tx.message.findFirst({
      where: { id: messageId, storeId },
      select: {
        conversationId: true,
        conversation: { select: { status: true, assignedTo: true } }
      }
    })
    if (message === null) return
    const clean = emoji === null ? '' : safeText(emoji)
    const key = keyOf(reactor)
    const where = { storeId, messageId, authorType: reactor.authorType, ...key }
    let changed: boolean
    if (clean === '') {
      changed = (await tx.messageReaction.deleteMany({ where })).count > 0
    } else {
      const existing = await tx.messageReaction.findFirst({ where, select: { emoji: true } })
      changed = existing?.emoji !== clean
      if (existing === null) {
        await tx.messageReaction.create({
          data: { storeId, messageId, authorType: reactor.authorType, emoji: clean, ...key }
        })
      } else if (changed) {
        await tx.messageReaction.updateMany({ where, data: { emoji: clean } })
      }
    }
    // A redelivered webhook or a repeated emoji changes nothing, and nobody needs to hear of it
    if (!changed) return
    this.events.publish(tx, Events.MESSAGE_REACTION, {
      storeId,
      conversationId: message.conversationId,
      messageId,
      visibility: {
        hidden: isHiddenStatus(message.conversation.status),
        assignedTo: message.conversation.assignedTo
      }
    })
  }
}
