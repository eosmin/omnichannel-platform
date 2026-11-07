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
  CaptionState,
  ChannelConnectionStatus,
  ChannelTextLimits,
  ChannelResultMetadata,
  ConversationStatus,
  DeliveryStatus,
  MediaStatus,
  MessageType,
  OutboundLimits,
  ReportedCaptionStates,
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
import { type ChannelPlugin, PluginError } from '@platform/plugins/sdk'

import { MessageStatusWriter, type StatusChange } from './message-status.writer'
import { providerCodesOf } from './provider-codes'
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
      [ChannelResultMetadata.CAPTION_STATE]: z.enum(ReportedCaptionStates).optional()
    })
    .optional()
})

// A file of a media message as the worker sends it
interface AttachmentToSend {
  id: string
  // Its place among the files of the message that are listed, from 0
  index: number
  // The place the agent gave it
  position: number
  contentType: string
  filename: string
  size: number
  isClean: boolean
  wasSent: boolean
  channelMessageId: string | null
  open: () => Promise<NodeJS.ReadableStream>
}

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
    // The files are uploaded to the provider from the platform's storage (`openFile`), one message each, in order;
    // the caption is the text under the first
    const isMedia = isOutboundMediaType(message.type)
    if (isMedia && plugin.sendMedia === undefined) {
      await this.fail(storeId, messageId, ErrorCodes.CHANNEL_CAPABILITY_UNSUPPORTED)
      return
    }
    const replyToExternalId = await this.externalIdOf(storeId, message.replyToMessageId)
    if (isMedia && plugin.sendMedia !== undefined) {
      await this.sendFiles({
        storeId,
        messageId,
        connectionRowId: connection.id,
        pluginId: connection.pluginId,
        context: this.contexts.contextFor(connection),
        sendMedia: plugin.sendMedia.bind(plugin),
        channelIdentity: customerIdentity.channelIdentity,
        content,
        replyToExternalId,
        resentAt: message.resentAt,
        isLastAttempt
      })
      return
    }

    let accepted: z.infer<typeof resultSchema>
    try {
      const result = resultSchema.safeParse(
        await withTimeout(
          template?.success === true && plugin.sendTemplate !== undefined
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
          errorName: errorName(error),
          // What the provider answered, as numbers: why Meta refused, without the token or the text
          ...providerCodesOf(error)
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
    accepted: z.infer<typeof resultSchema>,
    // Set when some file of the message did not go: the first one did, so its id and its text are written,
    // and the message is failed with this code
    failedWith?: ErrorCode
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
    // The id of the caption says it was sent; otherwise the plugin says how it stands
    const captionState =
      captionExternalId === undefined
        ? accepted.metadata?.[ChannelResultMetadata.CAPTION_STATE]
        : CaptionState.SENT
    const withoutId: StatusChange = {
      storeId,
      messageId,
      ...(failedWith === undefined
        ? { to: accepted.status }
        : { to: DeliveryStatus.FAILED, errorCode: failedWith }),
      ...(captionExternalId === undefined ? {} : { captionExternalId }),
      ...(captionState === undefined ? {} : { captionState })
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

  // The files of a media message in the order the agent gave, each with its own state and a way to open its
  // bytes. A message sent before each file had a state has one file with none: it counts as queued.
  private async filesOf(storeId: string, messageId: string): Promise<AttachmentToSend[]> {
    const rows = await this.prisma.client.media.findMany({
      where: { storeId, messageId },
      select: {
        id: true,
        key: true,
        filename: true,
        contentType: true,
        status: true,
        fileSize: true,
        position: true,
        deliveryStatus: true,
        channelMessageId: true
      },
      orderBy: [{ position: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }, { id: 'asc' }]
    })
    return rows.map((file, index) => ({
      id: file.id,
      index,
      position: file.position ?? index,
      contentType: file.contentType,
      filename: file.filename,
      // The size recorded when the file was checked: a plugin holds the upload to it
      size: file.fileSize,
      isClean: file.status === String(MediaStatus.CLEAN),
      wasSent: file.deliveryStatus === String(DeliveryStatus.SENT),
      channelMessageId: file.channelMessageId,
      // No link is signed: a plugin gets the bytes through `open`, and a signed link nobody reads is only one
      // more live credential to the storage in memory and in logs. Only the object of this row, read from the
      // platform's own storage, when the plugin is about to send: one stream for each attempt.
      open: async () => {
        // Checked again at the moment the bytes are read: a file marked infected or deleted since the
        // message was picked up must not be uploaded to anybody
        const stillClean = await this.prisma.client.media.count({
          where: { id: file.id, storeId, messageId, status: MediaStatus.CLEAN }
        })
        if (stillClean !== 1) {
          throw new PluginError(ErrorCodes.CHANNEL_MESSAGE_FAILED, { retryable: false })
        }
        const stream = await this.storage.stream(file.key)
        if (stream === null) {
          throw new PluginError(ErrorCodes.CHANNEL_MESSAGE_FAILED, { retryable: false })
        }
        return stream
      }
    }))
  }

  // Sends the files that the channel has not taken, one after the other: the next goes out when the provider has
  // answered for the previous, so they reach the customer in order. A file that fails is marked and the others
  // still go; a failure that may be repeated stops here while there are attempts left, and the next attempt skips
  // the files already sent. The message is sent when every file is, and failed when one is not.
  private async sendFiles(args: {
    storeId: string
    messageId: string
    connectionRowId: string
    pluginId: string
    context: ReturnType<ChannelContextFactory['contextFor']>
    sendMedia: NonNullable<ChannelPlugin['sendMedia']>
    channelIdentity: string
    content: string
    replyToExternalId: string | null
    resentAt: Date | null
    isLastAttempt: boolean
  }): Promise<void> {
    const { storeId, messageId } = args
    // Outside the try below: a database error here is ours, not the provider's
    const files = await this.filesOf(storeId, messageId)
    if (files.length === 0) {
      this.logger.warn({ storeId, messageId }, 'a media message has no file')
      await this.fail(storeId, messageId, ErrorCodes.FILE_UNAVAILABLE)
      return
    }
    const failures: ErrorCode[] = []
    // What the first file got, from this attempt; the caption goes with it
    let firstAccepted: z.infer<typeof resultSchema> | null = null
    for (const file of files) {
      if (file.wasSent) continue
      if (!file.isClean) {
        this.logger.warn(
          { storeId, messageId, position: file.position },
          'a file of a media message is not clean'
        )
        await this.markFile(storeId, messageId, file.id, {
          failedWith: ErrorCodes.FILE_UNAVAILABLE
        })
        failures.push(ErrorCodes.FILE_UNAVAILABLE)
        continue
      }
      // The first attempt is keyed by the message and the place of the file; one the agent asked for again is
      // another attempt, or a provider that dedupes on the key would answer with the result of the first. A
      // message of one file keeps the key it always had.
      const base = files.length === 1 ? messageId : `${messageId}-${file.position}`
      const idempotencyKey = args.resentAt === null ? base : `${base}-${args.resentAt.getTime()}`
      try {
        const result = resultSchema.safeParse(
          await withTimeout(
            args.sendMedia(args.context, {
              channelIdentity: args.channelIdentity,
              contentType: file.contentType,
              fileSize: file.size,
              openFile: file.open,
              filename: file.filename,
              // The text goes with the first file, and only while that one is still to be sent
              ...(file.index !== 0 || args.content.trim() === '' ? {} : { caption: args.content }),
              ...(args.replyToExternalId === null || file.index !== 0
                ? {}
                : { replyToExternalId: args.replyToExternalId }),
              idempotencyKey
            }),
            // A file is uploaded before the message is posted: the budget is the upload's too
            OutboundLimits.MEDIA_SEND_TIMEOUT_MS
          )
        )
        // Sent twice would be worse than not sent: an answer that makes no sense is final for this file
        if (!result.success) {
          await this.markFile(storeId, messageId, file.id, {
            failedWith: ErrorCodes.CHANNEL_MESSAGE_FAILED
          })
          failures.push(ErrorCodes.CHANNEL_MESSAGE_FAILED)
          continue
        }
        await this.markFile(storeId, messageId, file.id, { sent: result.data })
        if (file.index === 0) firstAccepted = result.data
      } catch (error) {
        const refused = refusalOf(error)
        // The message of the error may hold a token: only its name is logged, and none of it is stored
        this.logger.warn(
          {
            pluginId: args.pluginId,
            messageId,
            position: file.position,
            code: refused.code,
            errorName: errorName(error),
            // What the provider answered, as numbers: why Meta refused, without the token or the text
            ...providerCodesOf(error)
          },
          'sending a reply failed'
        )
        // Not `error` itself: the retry machinery logs it whole and keeps its text in Redis
        if (refused.retryable && !args.isLastAttempt)
          throw new SendAttemptFailed(refused.code, error)
        await this.markFile(storeId, messageId, file.id, { failedWith: refused.code })
        failures.push(refused.code)
      }
    }
    // The id of the message is the first file's, whichever attempt sent it: receipts and echoes find it there
    const first = files[0]
    const firstId =
      firstAccepted?.externalId ?? (first?.wasSent === true ? first.channelMessageId : null)
    const [failure] = failures
    // What the provider answered for the first file, or the id it gave on an earlier attempt
    const accepted =
      firstAccepted ??
      (firstId === null ? null : { externalId: firstId, status: DeliveryStatus.SENT as const })
    if (accepted === null) {
      // Nothing to record about the first file (it never went, or went with no id kept): only the state
      if (failure === undefined) {
        await this.status.apply({ storeId, messageId, to: DeliveryStatus.SENT })
      } else {
        await this.fail(storeId, messageId, failure)
      }
      return
    }
    await this.recordAccepted(storeId, messageId, args.connectionRowId, accepted, failure)
  }

  // What happened to one file, written on its row. The provider has the file when `sent` is given: nothing here
  // may make it be sent again, so a write that fails is tried a few times before the job fails.
  private async markFile(
    storeId: string,
    messageId: string,
    mediaId: string,
    outcome: { sent: z.infer<typeof resultSchema> } | { failedWith: ErrorCode }
  ): Promise<void> {
    const data =
      'sent' in outcome
        ? {
            deliveryStatus: DeliveryStatus.SENT,
            channelMessageId: outcome.sent.externalId,
            sentAt: new Date(),
            sendErrorCode: null
          }
        : { deliveryStatus: DeliveryStatus.FAILED, sendErrorCode: outcome.failedWith }
    for (let attempt = 1; ; attempt += 1) {
      try {
        await this.prisma.client.media.updateMany({
          // A file that is already `sent` is never taken back
          where: {
            id: mediaId,
            storeId,
            messageId,
            OR: [{ deliveryStatus: null }, { deliveryStatus: { not: DeliveryStatus.SENT } }]
          },
          data
        })
        return
      } catch (error) {
        if (attempt >= OutboundLimits.WRITE_ATTEMPTS) throw error
        await delay(OutboundLimits.WRITE_RETRY_DELAY_MS * attempt)
      }
    }
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
