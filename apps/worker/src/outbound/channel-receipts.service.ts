import { Injectable } from '@nestjs/common'
import { PinoLogger } from 'nestjs-pino'

import {
  CONNECTION_ROW_SELECT,
  ChannelHealthService,
  providerText
} from '@platform/channels/connections'
import { PrismaService } from '@platform/core/database'
import {
  AuthorType,
  ChannelConnectionStatus,
  ChannelHealthErrors,
  ChannelHealthLimits,
  DeliveryStatus,
  OutboundLimits,
  OfActiveInstallation
} from '@platform/core/domain'
import { ErrorCodes } from '@platform/core/errors'
import { ChannelConnectionResolver } from '@platform/core/messaging'
import type { ValidChannelEvent } from '@platform/plugins/runtime'
import { ChannelEventTypes } from '@platform/plugins/sdk'

import { MessageStatusWriter } from './message-status.writer'

const RECEIPT_STATES = {
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
    private readonly logger: PinoLogger
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
    const found = await this.prisma.client.message.findMany({
      where: {
        storeId: connection.storeId,
        channelMessageId: externalId,
        authorType: AuthorType.AGENT,
        conversation: { channelConnectionId: connection.id }
      },
      select: { id: true },
      take: 2
    })
    if (found.length > 1) {
      this.logger.warn(
        { pluginId },
        'receipt for a provider id that two messages share: not applied'
      )
      return
    }
    const message = found[0] ?? null
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
    const waiting = await this.prisma.client.message.count({
      where: {
        storeId: connection.storeId,
        deliveryStatus: DeliveryStatus.QUEUED,
        authorType: AuthorType.AGENT,
        createdAt: { gt: new Date(Date.now() - OutboundLimits.RECEIPT_WAIT_MS) },
        conversation: { channelConnectionId: connection.id }
      }
    })
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
    const row = await this.prisma.client.channelConnection.findFirst({
      where: {
        id: resolved.id,
        storeId: resolved.storeId,
        status: { in: [ChannelConnectionStatus.ACTIVE, ChannelConnectionStatus.ERROR] },
        ...OfActiveInstallation
      },
      select: CONNECTION_ROW_SELECT
    })
    if (row === null) return
    const reason = providerText(
      event.status?.error?.message ?? '',
      ChannelHealthLimits.ERROR_MAX_LENGTH
    )
    await this.health.record(row, {
      healthy: false,
      error: reason === '' ? ChannelHealthErrors.UNSPECIFIED : reason
    })
  }
}
