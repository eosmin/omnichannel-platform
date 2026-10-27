import { Injectable } from '@nestjs/common'
import { PinoLogger } from 'nestjs-pino'
import { z } from 'zod'

import {
  CONNECTION_ROW_SELECT,
  ChannelContextFactory,
  errorName,
  withTimeout
} from '@platform/channels/connections'
import { isUniqueViolation, PrismaService } from '@platform/core/database'
import {
  ChannelConnectionStatus,
  ChannelTextLimits,
  DeliveryStatus,
  MessageType,
  OutboundLimits
} from '@platform/core/domain'
import { ErrorCodes, type ErrorCode } from '@platform/core/errors'
import { enumValueOf } from '@platform/core/messaging'
import type { SendOutboundMessageJob } from '@platform/core/queues'
import { PluginRegistry } from '@platform/plugins/runtime'
import { PluginError } from '@platform/plugins/sdk'

import { MessageStatusWriter } from './message-status.writer'

// What a plugin answers is checked: it may be a third party's. The provider may report the message
// as already delivered or read (an email, a widget), never as queued.
const resultSchema = z.object({
  externalId: z.string().min(1).max(255),
  status: z.enum([DeliveryStatus.SENT, DeliveryStatus.DELIVERED, DeliveryStatus.READ])
})

// Why a send did not go out, and whether it is worth another try
interface Refusal {
  code: ErrorCode
  retryable: boolean
}

// The worker half of a reply (TDD_10 §6.7.4): takes the stored message, asks its channel's plugin to
// send it and writes the result. The job holds ids only; everything else is read now, so a retry
// sends what is stored and a message that was already settled is left alone.
@Injectable()
export class OutboundSender {
  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: PluginRegistry,
    private readonly contexts: ChannelContextFactory,
    private readonly status: MessageStatusWriter,
    private readonly logger: PinoLogger
  ) {
    this.logger.setContext(OutboundSender.name)
  }

  // Throws when the attempt should be repeated; returns when the message is settled, sent or failed
  async send(job: SendOutboundMessageJob, isLastAttempt: boolean): Promise<void> {
    const { storeId, messageId } = job
    const message = await this.prisma.client.message.findFirst({
      where: { id: messageId, storeId, deliveryStatus: DeliveryStatus.QUEUED },
      select: {
        type: true,
        content: true,
        replyToMessageId: true,
        conversation: {
          select: {
            channelType: true,
            customerIdentity: { select: { channelIdentity: true } },
            channelConnection: { select: CONNECTION_ROW_SELECT }
          }
        }
      }
    })
    // Gone, or already sent or failed: a second job for the same message (the sweep) has nothing to do
    if (message === null) return

    const { channelConnection: connection, channelType, customerIdentity } = message.conversation
    const plugin = this.registry.find(connection.pluginId)
    const refusal = this.refuseBeforeSending(message, channelType, connection.status)
    if (refusal !== null || plugin === undefined) {
      await this.fail(storeId, messageId, refusal?.code ?? ErrorCodes.CHANNEL_NOT_CONNECTED)
      return
    }
    const content = message.content ?? ''

    let accepted: z.infer<typeof resultSchema>
    try {
      const replyToExternalId = await this.externalIdOf(storeId, message.replyToMessageId)
      const result = resultSchema.safeParse(
        await withTimeout(
          plugin.sendMessage(this.contexts.contextFor(connection), {
            channelIdentity: customerIdentity.channelIdentity,
            content,
            ...(replyToExternalId === null ? {} : { replyToExternalId }),
            // The provider that supports it never sends one message twice
            idempotencyKey: messageId
          }),
          OutboundLimits.SEND_TIMEOUT_MS
        )
      )
      // Sent twice would be worse than not sent: an answer that makes no sense is final
      if (!result.success) {
        await this.fail(storeId, messageId, ErrorCodes.CHANNEL_MESSAGE_FAILED)
        return
      }
      accepted = result.data
    } catch (error) {
      const refused = this.refusalOf(error)
      // The message of the error may hold a token: only its name is logged, and none of it is stored
      this.logger.warn(
        {
          pluginId: connection.pluginId,
          messageId,
          code: refused.code,
          errorName: errorName(error)
        },
        'sending a reply failed'
      )
      if (refused.retryable && !isLastAttempt) throw error
      await this.fail(storeId, messageId, refused.code)
      return
    }
    await this.recordAccepted(storeId, messageId, accepted)
  }

  // The provider has the message: nothing here may make it be sent again. A provider id already
  // used in the conversation (a plugin that repeats ids) is not worth a second send; the message is
  // marked without it.
  private async recordAccepted(
    storeId: string,
    messageId: string,
    accepted: z.infer<typeof resultSchema>
  ): Promise<void> {
    try {
      await this.status.apply({
        storeId,
        messageId,
        to: accepted.status,
        channelMessageId: accepted.externalId
      })
    } catch (error) {
      if (!isUniqueViolation(error)) throw error
      this.logger.warn({ messageId }, 'the provider id of a reply was already used')
      await this.status.apply({ storeId, messageId, to: accepted.status })
    }
  }

  private refuseBeforeSending(
    message: { type: string; content: string | null },
    channelType: string,
    connectionStatus: string
  ): Refusal | null {
    if (
      enumValueOf(ChannelConnectionStatus, connectionStatus, 'channel connection status') ===
      ChannelConnectionStatus.DISCONNECTED
    ) {
      return { code: ErrorCodes.CHANNEL_NOT_CONNECTED, retryable: false }
    }
    if (enumValueOf(MessageType, message.type, 'message type') !== MessageType.TEXT) {
      return { code: ErrorCodes.CHANNEL_CAPABILITY_UNSUPPORTED, retryable: false }
    }
    const text = message.content ?? ''
    const limit = ChannelTextLimits[channelType]
    if (text.trim() === '' || (limit !== undefined && Array.from(text).length > limit)) {
      return { code: ErrorCodes.CHANNEL_MESSAGE_FAILED, retryable: false }
    }
    return null
  }

  // A plugin says whether to try again (it wins over anything else); a network error or a timeout is
  // tried again, and so is anything else that is not the plugin's word: it is ours or the network's
  private refusalOf(error: unknown): Refusal {
    if (error instanceof PluginError) {
      return { code: error.code, retryable: error.retryable === true }
    }
    return { code: ErrorCodes.CHANNEL_MESSAGE_FAILED, retryable: true }
  }

  private async externalIdOf(storeId: string, messageId: string | null): Promise<string | null> {
    if (messageId === null) return null
    const target = await this.prisma.client.message.findFirst({
      where: { id: messageId, storeId },
      select: { channelMessageId: true }
    })
    return target?.channelMessageId ?? null
  }

  private async fail(storeId: string, messageId: string, errorCode: ErrorCode): Promise<void> {
    await this.status.apply({ storeId, messageId, to: DeliveryStatus.FAILED, errorCode })
  }
}
