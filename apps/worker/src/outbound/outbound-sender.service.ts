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

import { MessageStatusWriter, type StatusChange } from './message-status.writer'

// What a plugin answers is checked: it may be a third party's. The provider may report the message
// as already delivered or read (an email, a widget), never as queued.
const resultSchema = z.object({
  externalId: z.string().min(1).max(255),
  status: z.enum([DeliveryStatus.SENT, DeliveryStatus.DELIVERED, DeliveryStatus.READ])
})

// What the retry sees of a failed attempt: the code and the name of the error, never its text. The
// error of a plugin or of the network can carry the token it was called with, and BullMQ logs what is
// thrown and keeps it in Redis.
class SendAttemptFailed extends Error {
  constructor(code: ErrorCode, cause: unknown) {
    super(`sending a reply failed: ${code} (${errorName(cause)})`)
    this.name = 'SendAttemptFailed'
  }
}

const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

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
    const refusal = this.refusalBeforeSending(message, channelType, connection.status)
    if (refusal !== null) {
      await this.fail(storeId, messageId, refusal.code)
      return
    }
    const plugin = this.registry.find(connection.pluginId)
    if (plugin === undefined) {
      // A plugin that is not registered yet (a registry that is still filling) is not a connection
      // that is gone: the retries come first, and only the last attempt gives up
      if (!isLastAttempt) throw new Error('the plugin of the connection is not registered')
      await this.fail(storeId, messageId, ErrorCodes.CHANNEL_NOT_CONNECTED)
      return
    }
    const content = message.content ?? ''
    // Outside the try below: a database error here is ours, not the provider's
    const replyToExternalId = await this.externalIdOf(storeId, message.replyToMessageId)

    let accepted: z.infer<typeof resultSchema>
    try {
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
      // Not `error` itself: the retry machinery logs it whole and keeps its text in Redis
      if (refused.retryable && !isLastAttempt) throw new SendAttemptFailed(refused.code, error)
      await this.fail(storeId, messageId, refused.code)
      return
    }
    await this.recordAccepted(storeId, messageId, connection.id, accepted)
  }

  // The provider has the message: nothing here may make it be sent again. A write that fails is tried
  // a few times before the job fails, because the job would send the reply a second time. A provider
  // id already used on the connection (a plugin that repeats ids) is not worth a second send; the
  // message is marked without it, because a receipt finds a message by connection and an id held by
  // two could not be told apart. The check can lose a race with another writer: the unique index has
  // the last word, and a violation is the same answer.
  private async recordAccepted(
    storeId: string,
    messageId: string,
    connectionRowId: string,
    accepted: z.infer<typeof resultSchema>
  ): Promise<void> {
    const taken = await this.prisma.client.message.count({
      where: {
        storeId,
        channelMessageId: accepted.externalId,
        id: { not: messageId },
        conversation: { channelConnectionId: connectionRowId }
      }
    })
    if (taken > 0) this.logger.warn({ messageId }, 'the provider id of a reply was already used')
    const withoutId = { storeId, messageId, to: accepted.status }
    let change: StatusChange =
      taken > 0 ? withoutId : { ...withoutId, channelMessageId: accepted.externalId }
    for (let attempt = 1; ; attempt += 1) {
      try {
        await this.status.apply(change)
        return
      } catch (error) {
        if (attempt >= OutboundLimits.WRITE_ATTEMPTS) throw error
        if (isUniqueViolation(error)) change = withoutId
        await delay(OutboundLimits.WRITE_RETRY_DELAY_MS * attempt)
      }
    }
  }

  // A value the worker does not know (a status or a type written by a newer version) cannot be sent
  // and will not become one: it fails the message, and does not leave it queued for the sweep
  private refusalBeforeSending(
    message: { type: string; content: string | null },
    channelType: string,
    connectionStatus: string
  ): Refusal | null {
    try {
      return this.refuseBeforeSending(message, channelType, connectionStatus)
    } catch (error) {
      this.logger.error(
        { errorName: errorName(error), channelType },
        'a reply could not be checked'
      )
      return { code: ErrorCodes.CHANNEL_MESSAGE_FAILED, retryable: false }
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
