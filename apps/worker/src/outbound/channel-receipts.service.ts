// rls-context: every database access of this file runs inside a JobContext (forStore, or forUser for an avatar) opened around that one call; the provider, the bucket and the scanner are called outside of it
import { Injectable } from '@nestjs/common'
import { PinoLogger } from 'nestjs-pino'

import {
  CONNECTION_ROW_SELECT,
  ChannelHealthService,
  pluginHealthReason
} from '@platform/channels/connections'
import { PrismaService, JobContext } from '@platform/core/database'
import {
  AuthorType,
  ChannelConnectionStatus,
  DeliveryStatus,
  OutboundLimits,
  OfActiveInstallation
} from '@platform/core/domain'
import { ErrorCodes } from '@platform/core/errors'
import { ChannelConnectionResolver } from '@platform/core/messaging'
import type { ValidChannelEvent } from '@platform/plugins/runtime'
import { ChannelEventTypes } from '@platform/plugins/sdk'

import { MessageStatusWriter, statesBefore } from './message-status.writer'

// A reply that went out to the customer: an agent's, or what a plugin wrote as the system (it goes out like any reply). Notes
// and the customer's own messages never get a receipt
const TEAM_REPLY = {
  OR: [
    { authorType: AuthorType.AGENT },
    { authorType: AuthorType.SYSTEM, authorPluginId: { not: null } }
  ]
}

const RECEIPT_STATES = {
  [ChannelEventTypes.MESSAGE_SENT]: DeliveryStatus.SENT,
  [ChannelEventTypes.MESSAGE_DELIVERED]: DeliveryStatus.DELIVERED,
  [ChannelEventTypes.MESSAGE_READ]: DeliveryStatus.READ,
  [ChannelEventTypes.MESSAGE_FAILED]: DeliveryStatus.FAILED
} as const

// What a provider says about messages the platform sent, and about the connection itself. The store
// is the one of the connection found by (plugin, connection id), and the message is looked up inside
// that connection: an event cannot reach a message of another account.
@Injectable()
export class ChannelReceipts {
  constructor(
    private readonly prisma: PrismaService,
    private readonly connections: ChannelConnectionResolver,
    private readonly status: MessageStatusWriter,
    private readonly health: ChannelHealthService,
    private readonly logger: PinoLogger,
    private readonly jobContext: JobContext
  ) {
    this.logger.setContext(ChannelReceipts.name)
  }

  // Throws, so that the queue tries again, when the receipt may have beaten the write of its own
  // message: a reply of this connection was queued a moment ago and has no provider id yet. On the
  // last attempt it gives up quietly: a receipt that never finds its message is not a failed job.
  async handleReceipt(
    pluginId: string,
    event: ValidChannelEvent & { type: keyof typeof RECEIPT_STATES },
    isLastAttempt: boolean
  ): Promise<void> {
    const connection = await this.connections.resolve(pluginId, event.connectionId)
    const externalId = event.status?.externalId
    if (connection === null || externalId === undefined) return
    // Two at most: a provider id is unique per conversation, not per connection, and a plugin that
    // repeats ids must not make a receipt land on the first of them it happens to find
    const found = await this.jobContext.forStore(connection.storeId, () =>
      this.prisma.client.message.findMany({
        where: {
          storeId: connection.storeId,
          channelMessageId: externalId,
          ...TEAM_REPLY,
          conversation: { channelConnectionId: connection.id }
        },
        select: { id: true },
        take: 2
      })
    )
    if (found.length > 1) {
      this.logger.warn(
        { pluginId },
        'receipt for a provider id that two messages share: not applied'
      )
      return
    }
    let message = found[0] ?? null
    // A file after the first of a message has its own provider id, kept on its row: a receipt of it is a receipt
    // of its message (a file that did not arrive fails it), and the file keeps its own state
    if (message === null) {
      const file = await this.jobContext.forStore(connection.storeId, () =>
        this.prisma.client.media.findFirst({
          where: {
            storeId: connection.storeId,
            channelMessageId: externalId,
            message: {
              ...TEAM_REPLY,
              conversation: { channelConnectionId: connection.id }
            }
          },
          select: { messageId: true }
        })
      )
      if (file?.messageId != null) {
        message = { id: file.messageId }
      }
    }
    // A plugin that holds the id of the platform (`messageId`, the one it was given with the send) and whose provider id the
    // platform does not have, or has differently: the message is found by that id, inside this connection and among the
    // replies of the team (an agent's, or a plugin's as the system), so it still cannot reach a message of another account (TDD_10 §6.7.5)
    if (message === null && event.messageId !== undefined) {
      message = await this.jobContext.forStore(connection.storeId, () =>
        this.prisma.client.message.findFirst({
          where: {
            id: event.messageId,
            storeId: connection.storeId,
            ...TEAM_REPLY,
            conversation: { channelConnectionId: connection.id }
          },
          select: { id: true }
        })
      )
    }
    // A receipt for a message this platform did not send (it went out from the phone) or one it has
    // not finished writing: nothing to update
    if (message === null) {
      if (!isLastAttempt && (await this.mayBeWaitingForItsId(connection))) {
        throw new Error('the receipt came before the provider id of its message was written')
      }
      this.logger.debug({ pluginId }, 'receipt for an unknown message')
      return
    }
    const to = RECEIPT_STATES[event.type]
    // The file the receipt is about keeps its own state, whichever file of the message it is
    await this.jobContext.forStore(connection.storeId, () =>
      this.prisma.client.media.updateMany({
        where: {
          storeId: connection.storeId,
          messageId: message.id,
          channelMessageId: externalId,
          deliveryStatus: { in: statesBefore(to) }
        },
        data: {
          deliveryStatus: to,
          sendErrorCode: to === DeliveryStatus.FAILED ? ErrorCodes.CHANNEL_MESSAGE_FAILED : null
        }
      })
    )
    // A message of several files is delivered, or read, when every one of its files is: the receipt of one file
    // moves that file, and the message only when it was the last. A failure of any file fails the message (the
    // agent sends again the files that failed).
    if (to !== DeliveryStatus.FAILED) {
      const states = await this.jobContext.forStore(connection.storeId, () =>
        this.prisma.client.media.findMany({
          where: { storeId: connection.storeId, messageId: message.id, position: { not: null } },
          select: { deliveryStatus: true }
        })
      )
      const reached =
        to === DeliveryStatus.READ
          ? [DeliveryStatus.READ]
          : to === DeliveryStatus.SENT
            ? [DeliveryStatus.SENT, DeliveryStatus.DELIVERED, DeliveryStatus.READ]
            : [DeliveryStatus.DELIVERED, DeliveryStatus.READ]
      if (
        states.length > 1 &&
        states.some(file => !reached.some(state => state === file.deliveryStatus))
      ) {
        return
      }
    }
    await this.status.apply({
      storeId: connection.storeId,
      messageId: message.id,
      to,
      // What the provider said about the failure is not kept: the code is ours
      ...(to === DeliveryStatus.FAILED ? { errorCode: ErrorCodes.CHANNEL_MESSAGE_FAILED } : {})
    })
  }

  private async mayBeWaitingForItsId(connection: {
    id: string
    storeId: string
  }): Promise<boolean> {
    const waiting = await this.jobContext.forStore(connection.storeId, () =>
      this.prisma.client.message.count({
        where: {
          storeId: connection.storeId,
          deliveryStatus: DeliveryStatus.QUEUED,
          ...TEAM_REPLY,
          createdAt: { gt: new Date(Date.now() - OutboundLimits.RECEIPT_WAIT_MS) },
          conversation: { channelConnectionId: connection.id }
        }
      })
    )
    return waiting > 0
  }

  // The provider says the connection cannot work (a token revoked). It goes to the state of the health
  // check, which also tells the agents; the next good check brings it back.
  async handleConnectionError(
    pluginId: string,
    event: ValidChannelEvent & { type: typeof ChannelEventTypes.CONNECTION_ERROR }
  ): Promise<void> {
    const resolved = await this.connections.resolve(pluginId, event.connectionId)
    if (resolved === null) return
    const row = await this.jobContext.forStore(resolved.storeId, () =>
      this.prisma.client.channelConnection.findFirst({
        where: {
          id: resolved.id,
          storeId: resolved.storeId,
          status: { in: [ChannelConnectionStatus.ACTIVE, ChannelConnectionStatus.ERROR] },
          ...OfActiveInstallation
        },
        select: CONNECTION_ROW_SELECT
      })
    )
    if (row === null) return
    await this.health.record(row, {
      healthy: false,
      error: pluginHealthReason(event.status?.error?.message ?? '')
    })
  }
}
