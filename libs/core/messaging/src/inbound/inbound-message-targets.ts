import { Injectable } from '@nestjs/common'

import {
  lockStoreForWrite,
  lockStoreScope,
  PrismaService,
  type PrismaTransaction
} from '@platform/core/database'
import { AuthorType } from '@platform/core/domain'

import { ChannelConnectionResolver } from '../channels/channel-connection.resolver'
import { parseChannelIdentity } from '../customers/identity'
import { isTargetOfItsOwn, messageOfProviderId } from '../messages/provider-message-match'

import {
  countersOf,
  type MissingTargetShape,
  missingTargetShapeOrNull
} from './missing-target-shape'

export interface InboundTargetEvent {
  connectionId: string
  channelIdentity: string
  targetExternalId: string
  // A reaction is about the whole message, so an id of any of its files, or of the text sent apart under a
  // file, names it. An edit or a deletion is about ONE provider message: it keeps to the id of the message
  // itself, or the deletion of one file would take the whole message with it.
  namesFilesToo?: boolean
  // The event takes a reaction back: it looks for the one that is there under the file named
  removal?: boolean
}

export interface InboundTarget {
  storeId: string
  customerIdentityId: string
  messageId: string
  // The file of an album that the id named, when the id is a file's and the message has several (a reaction is
  // under that file); null: the message itself
  mediaId: string | null
}

// Finds the stored message that an event of a channel is about (a reaction, an edit, a deletion): the
// message with that provider id, in a thread of that customer on that connection. None of these events
// opens a customer or a conversation, so what has nothing to attach to is dropped.
//
// The message, or the customer, may not be stored yet (the events of a handle are not ordered): until
// the last attempt it throws, so that the queue tries again.
@Injectable()
export class InboundMessageTargets {
  constructor(
    private readonly prisma: PrismaService,
    private readonly connections: ChannelConnectionResolver
  ) {}

  // Runs `apply` inside the transaction that holds the locks of the store and of the handle, and
  // returns whether it ran
  async apply(
    pluginId: string,
    event: InboundTargetEvent,
    what: string,
    isLastAttempt: boolean,
    apply: (tx: PrismaTransaction, target: InboundTarget) => Promise<void>,
    // Told, on the last attempt, the shape of an id that matched no message (see `missingTargetShape`)
    onMissing?: (shape: MissingTargetShape) => void
  ): Promise<boolean> {
    const connection = await this.connections.resolve(pluginId, event.connectionId)
    if (connection === null || !connection.active) return false
    const { storeId } = connection
    const parsed = parseChannelIdentity(pluginId, event.channelIdentity, { fromChannel: true })
    if (parsed === null) return false
    const identity = await this.prisma.client.customerIdentity.findFirst({
      where: { storeId, channelType: pluginId, channelIdentity: parsed.identity },
      select: { id: true }
    })
    if (identity === null) {
      // The message of that customer may be being stored right now, and makes the identity
      if (!isLastAttempt) throw new Error(`the ${what} came before the customer it is from`)
      return false
    }
    let missing = false
    const applied = await this.prisma.transaction(async tx => {
      await lockStoreForWrite(tx, storeId)
      // Takes turns with the messages of the same handle: the event may follow its message closely
      await lockStoreScope(tx, storeId, `inbound-${identity.id}`)
      const target = await tx.message.findFirst({
        where: {
          storeId,
          ...(event.namesFilesToo === true
            ? { AND: [messageOfProviderId(storeId, event.targetExternalId)] }
            : { channelMessageId: event.targetExternalId }),
          conversation: { customerIdentityId: identity.id, channelConnectionId: connection.id }
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: { id: true, channelMessageId: true, _count: { select: { media: true } } }
      })
      if (target === null) {
        if (!isLastAttempt) throw new Error(`the ${what} came before the message it points at`)
        missing = true
        return false
      }
      // Only a file the provider can tell apart is a target of its own (see `isTargetOfItsOwn`): the first file is the
      // message, and files that share one id cannot be told apart. A message with one file (or none) is
      // reacted to as a whole.
      let mediaId: string | null = null
      if (event.namesFilesToo === true && target._count.media > 1) {
        const files = await tx.media.findMany({
          where: { storeId, messageId: target.id },
          select: { id: true, channelMessageId: true }
        })
        const named = files.find(item => item.channelMessageId === event.targetExternalId)
        if (named !== undefined && isTargetOfItsOwn(target, files, named)) mediaId = named.id
        // A removal finds the reaction where it was put even if the file cannot be told apart now (a later file
        // shares its id): the row under that file is the one that goes
        if (mediaId === null && named !== undefined && event.removal === true) {
          const there = await tx.messageReaction.count({
            where: {
              storeId,
              messageId: target.id,
              customerIdentityId: identity.id,
              mediaId: named.id
            }
          })
          if (there > 0) mediaId = named.id
        }
      }
      await apply(tx, {
        storeId,
        customerIdentityId: identity.id,
        messageId: target.id,
        mediaId
      })
      return true
    })
    // The shape of the id that matched nothing is read once the transaction is over: a count that failed inside it
    // would have aborted the transaction of the reaction
    if (missing && onMissing) {
      const shape = await missingTargetShapeOrNull({
        targetId: event.targetExternalId,
        now: new Date(),
        count: countersOf(
          this.prisma.client,
          {
            storeId,
            conversation: { customerIdentityId: identity.id, channelConnectionId: connection.id }
          },
          AuthorType.CUSTOMER
        )
      })
      if (shape) onMissing(shape)
    }
    return applied
  }
}
