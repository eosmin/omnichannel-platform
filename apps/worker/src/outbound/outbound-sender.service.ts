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
  ChannelResultMetadata,
  ConversationStatus,
  DeliveryStatus,
  MediaStatus,
  MessageType,
  OutboundLimits,
  isInstallationActive
} from '@platform/core/domain'
import { ErrorCodes, type ErrorCode } from '@platform/core/errors'
import { DomainEvents } from '@platform/core/event-bus'
import { Events } from '@platform/core/events'
import {
  ConversationsService,
  enumValueOf,
  isClosingMessage,
  MessagingWindowService,
  publishMessageChanged,
  templateMetadataSchema
} from '@platform/core/messaging'
import type { SendOutboundMessageJob } from '@platform/core/queues'
import { isOutboundMediaType } from '@platform/core/storage'
import { StorageService } from '@platform/core/storage-module'
import { PluginRegistry } from '@platform/plugins/runtime'

import { MessageStatusWriter, type StatusChange } from './message-status.writer'
import { type Refusal, refusalOf, SendAttemptFailed } from './send-refusal'

// What a plugin answers is checked: it may be a third party's. The provider may report the message
// as already delivered or read (an email, a widget), never as queued.
const resultSchema = z.object({
  externalId: z.string().min(1).max(255),
  status: z.enum([DeliveryStatus.SENT, DeliveryStatus.DELIVERED, DeliveryStatus.READ]),
  // Only what the core uses is read; anything else the plugin adds is dropped
  metadata: z
    .object({
      [ChannelResultMetadata.CAPTION_EXTERNAL_ID]: z.string().min(1).max(255).optional(),
      [ChannelResultMetadata.CAPTION_FAILED]: z.boolean().optional()
    })
    .optional()
})

const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

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
    private readonly conversations: ConversationsService,
    private readonly window: MessagingWindowService,
    private readonly events: DomainEvents,
    private readonly storage: StorageService,
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
        metadata: true,
        resentAt: true,
        replyToMessageId: true,
        createdAt: true,
        conversation: {
          select: {
            id: true,
            status: true,
            resolvedAt: true,
            channelType: true,
            customerIdentity: { select: { channelIdentity: true } },
            channelConnection: {
              select: {
                ...CONNECTION_ROW_SELECT,
                installation: { select: { status: true, plugin: { select: { status: true } } } }
              }
            }
          }
        }
      }
    })
    // Gone, or already sent or failed: a second job for the same message (the sweep) has nothing to do
    if (message === null) return
    const isClosing = isClosingMessage(message.metadata)
    if (isClosing && !(await this.discardUnlessStanding(storeId, messageId, message))) return

    const { channelConnection: connection, channelType, customerIdentity } = message.conversation
    // A connection of an installation that is not active sends nothing, as a disconnected one
    const connectionStatus = isInstallationActive(connection.installation)
      ? connection.status
      : ChannelConnectionStatus.DISCONNECTED
    const refusal = this.refusalBeforeSending(message, channelType, connectionStatus)
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
    // The first attempt is keyed by the message; one the agent asked for again is another attempt, or a
    // provider that dedupes on the key would answer with the result of the first
    const idempotencyKey =
      message.resentAt === null ? messageId : `${messageId}-${message.resentAt.getTime()}`
    // A template is sent by name, language and variables; the stored text is only what the thread shows
    const isTemplate = message.type === String(MessageType.TEMPLATE)
    const template = isTemplate ? templateMetadataSchema.safeParse(message.metadata) : null
    if (template !== null && !template.success) {
      await this.fail(storeId, messageId, ErrorCodes.CHANNEL_MESSAGE_FAILED)
      return
    }
    if (isTemplate && plugin.sendTemplate === undefined) {
      await this.fail(storeId, messageId, ErrorCodes.CHANNEL_CAPABILITY_UNSUPPORTED)
      return
    }
    // A file is sent by a signed link the provider fetches; the caption is the text under it
    const isMedia = isOutboundMediaType(message.type)
    if (isMedia && plugin.sendMedia === undefined) {
      await this.fail(storeId, messageId, ErrorCodes.CHANNEL_CAPABILITY_UNSUPPORTED)
      return
    }
    // Outside the try below: a database error here is ours, not the provider's
    const file = isMedia ? await this.fileOf(storeId, messageId) : null
    if (isMedia && file === null) {
      await this.fail(storeId, messageId, ErrorCodes.FILE_UNAVAILABLE)
      return
    }
    const replyToExternalId = await this.externalIdOf(storeId, message.replyToMessageId)

    let accepted: z.infer<typeof resultSchema>
    try {
      const result = resultSchema.safeParse(
        await withTimeout(
          file !== null && plugin.sendMedia !== undefined
            ? plugin.sendMedia(this.contexts.contextFor(connection), {
                channelIdentity: customerIdentity.channelIdentity,
                mediaUrl: file.url,
                contentType: file.contentType,
                filename: file.filename,
                ...(content.trim() === '' ? {} : { caption: content }),
                ...(replyToExternalId === null ? {} : { replyToExternalId }),
                idempotencyKey
              })
            : template?.success === true && plugin.sendTemplate !== undefined
              ? plugin.sendTemplate(this.contexts.contextFor(connection), {
                  channelIdentity: customerIdentity.channelIdentity,
                  templateName: template.data.template.name,
                  language: template.data.template.language,
                  variables: template.data.template.variables,
                  idempotencyKey
                })
              : plugin.sendMessage(this.contexts.contextFor(connection), {
                  channelIdentity: customerIdentity.channelIdentity,
                  content,
                  ...(replyToExternalId === null ? {} : { replyToExternalId }),
                  // The provider that supports it never sends one message twice
                  idempotencyKey
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
      const refused = refusalOf(error)
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
    // Once, and only for a reply the provider took: a failed or retried attempt is no answer
    if (isClosing) {
      await this.prisma.transaction(tx =>
        this.conversations.recordReply(tx, storeId, message.conversation.id, message.createdAt)
      )
    }
  }

  // The closing message of a resolution goes only while that resolution stands: an Undo, or a reply of
  // the customer, reopened the conversation, and one resolved again since is another resolution with
  // its own message. A message that does not go is deleted: it was never sent, so it leaves no trace
  // (`failed` would show a red bubble, and a `queued` one would be requeued by the sweep).
  private async discardUnlessStanding(
    storeId: string,
    messageId: string,
    message: {
      conversation: { id: string; status: string; resolvedAt: Date | null }
      createdAt: Date
    }
  ): Promise<boolean> {
    const { conversation } = message
    // The window was open when the agent resolved; it may have closed during the wait, and free text
    // sent after it would only come back as a red bubble
    const stands =
      conversation.status === String(ConversationStatus.RESOLVED) &&
      conversation.resolvedAt !== null &&
      conversation.resolvedAt <= message.createdAt &&
      (await this.window.isOpen(this.prisma.client, storeId, conversation.id))
    if (stands) return true
    await this.prisma.transaction(async tx => {
      await publishMessageChanged(this.events, tx, Events.MESSAGE_DELETED, storeId, messageId)
      await tx.message.deleteMany({
        where: { id: messageId, storeId, deliveryStatus: DeliveryStatus.QUEUED }
      })
    })
    return false
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
    const captionExternalId = accepted.metadata?.[ChannelResultMetadata.CAPTION_EXTERNAL_ID]
    const captionFailed = accepted.metadata?.[ChannelResultMetadata.CAPTION_FAILED] === true
    const withoutId: StatusChange = {
      storeId,
      messageId,
      to: accepted.status,
      ...(captionExternalId === undefined ? {} : { captionExternalId }),
      ...(captionFailed ? { captionFailed } : {})
    }
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
    const type = enumValueOf(MessageType, message.type, 'message type')
    // The text of a template is what the thread shows: the limits below are the ones of free text
    if (type === MessageType.TEMPLATE) return null
    // A file may go with no text under it; the caption has the limit of the text of its channel here
    // and the limit of its own kind of file in the plugin
    const isMedia = isOutboundMediaType(type)
    if (type !== MessageType.TEXT && !isMedia) {
      return { code: ErrorCodes.CHANNEL_CAPABILITY_UNSUPPORTED, retryable: false }
    }
    const text = message.content ?? ''
    const limit = ChannelTextLimits[channelType]
    if (
      (!isMedia && text.trim() === '') ||
      (limit !== undefined && Array.from(text).length > limit)
    ) {
      return { code: ErrorCodes.CHANNEL_MESSAGE_FAILED, retryable: false }
    }
    return null
  }

  // The one file of a media message, with the link the provider will fetch. Only a clean file goes: a
  // file that was infected or deleted since the message was written is a failed message.
  private async fileOf(
    storeId: string,
    messageId: string
  ): Promise<{ url: string; contentType: string; filename: string } | null> {
    const files = await this.prisma.client.media.findMany({
      where: { storeId, messageId },
      select: { key: true, filename: true, contentType: true, status: true }
    })
    const [file] = files
    if (files.length !== 1 || file === undefined || file.status !== String(MediaStatus.CLEAN)) {
      this.logger.warn(
        { storeId, messageId, files: files.map(item => item.status) },
        'the file of a media message is missing, not clean or not alone'
      )
      return null
    }
    const url = await this.storage.downloadUrl({
      key: file.key,
      contentType: file.contentType,
      filename: file.filename
    })
    return { url, contentType: file.contentType, filename: file.filename }
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
