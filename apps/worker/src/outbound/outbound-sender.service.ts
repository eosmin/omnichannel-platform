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
import { ErrorCodes, type ErrorCode, PlatformException } from '@platform/core/errors'
import { DomainEvents } from '@platform/core/event-bus'
import { Events } from '@platform/core/events'
import {
  ConversationsService,
  enumValueOf,
  captionProblemOf,
  carriesNoCaption,
  isClosingMessage,
  lockConversationForWrite,
  MessagingWindowService,
  publishMessageChanged,
  templateMetadataSchema
} from '@platform/core/messaging'
import type { SendOutboundMessageJob } from '@platform/core/queues'
import { isOutboundMediaType } from '@platform/core/storage'
import { StorageService } from '@platform/core/storage-module'
import { PluginRegistry } from '@platform/plugins/runtime'
import { type ChannelPlugin, PluginError } from '@platform/plugins/sdk'

import { albumSendBudgetMs, pickAlbum } from './album-groups'
import { isDefinitiveRefusal } from './definitive-refusal'
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

// What a plugin answers for an album: the result of a message, and the id of each file when the provider has one
// for each (checked against the files before it is used)
const albumResultSchema = resultSchema.extend({
  fileExternalIds: z.array(z.string().min(1).max(255)).optional()
})

// What happened to the files of one album
type AlbumOutcome =
  | { kind: 'sent'; accepted: z.infer<typeof resultSchema>; fileIds: readonly string[] | undefined }
  | { kind: 'failed'; code: ErrorCode; outcomeKnown: boolean }
  // The provider refused the album in so many words and nothing reached the customer: the files go one by one
  | { kind: 'fallback' }

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
  failedBefore: boolean
  earlierErrorCode: string | null
  channelMessageId: string | null
  // The text the agent put under this file (the first file's is the message's); null when none
  caption: string | null
  open: () => Promise<NodeJS.ReadableStream>
}

// The states of a file the provider has taken
const SENT_STATES: readonly string[] = [
  DeliveryStatus.SENT,
  DeliveryStatus.DELIVERED,
  DeliveryStatus.READ
]

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
        // The text of the message goes as a message of its own after the files, and where it stands
        textApart: true,
        captionState: true,
        metadata: true,
        // `false` while queued: an earlier attempt, or an earlier send that was resent, may have reached the provider
        failureDefinitive: true,
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
    // Whatever an earlier attempt left: from here on a failure is definitive only if nothing before it may have gone
    const tainted = message.failureDefinitive === false
    const isClosing = isClosingMessage(message.metadata)
    // A retry of an attempt that may have reached the provider (`tainted`) is past the point of no return:
    // the customer may have the message and have answered it, so it is not judged again nor deleted
    if (isClosing && !tainted && !(await this.claimClosingMessage(storeId, messageId, message))) {
      return
    }

    const { channelConnection: connection, channelType, customerIdentity } = message.conversation
    // A connection of an installation that is not active sends nothing, as a disconnected one
    const connectionStatus = isInstallationActive(connection.installation)
      ? connection.status
      : ChannelConnectionStatus.DISCONNECTED
    const refusal = this.refusalBeforeSending(message, channelType, connectionStatus)
    if (refusal !== null) {
      await this.fail(storeId, messageId, refusal.code, !tainted)
      return
    }
    const plugin = this.registry.find(connection.pluginId)
    if (plugin === undefined) {
      // A plugin that is not registered yet (a registry that is still filling) is not a connection
      // that is gone: the retries come first, and only the last attempt gives up
      if (!isLastAttempt) {
        // Nothing was sent: the claim of a closing message gives its mark back
        if (isClosing && !tainted) await this.clearInFlight(storeId, messageId)
        throw new Error('the plugin of the connection is not registered')
      }
      await this.fail(storeId, messageId, ErrorCodes.CHANNEL_NOT_CONNECTED, !tainted)
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
      await this.fail(storeId, messageId, ErrorCodes.CHANNEL_MESSAGE_FAILED, !tainted)
      return
    }
    if (isTemplate && plugin.sendTemplate === undefined) {
      await this.fail(storeId, messageId, ErrorCodes.CHANNEL_CAPABILITY_UNSUPPORTED, !tainted)
      return
    }
    // The files are uploaded to the provider from the platform's storage (`openFile`), one message each, in order;
    // the caption is the text under the first
    const isMedia = isOutboundMediaType(message.type)
    if (isMedia && plugin.sendMedia === undefined) {
      await this.fail(storeId, messageId, ErrorCodes.CHANNEL_CAPABILITY_UNSUPPORTED, !tainted)
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
        // Only a channel that declared an album (and so has the method) sends the images of a message together
        sendAlbum: plugin.sendAlbum?.bind(plugin),
        media: this.registry.mediaOf(connection.pluginId),
        sendText: plugin.sendMessage.bind(plugin),
        conversationId: message.conversation.id,
        channelType,
        messageType: enumValueOf(MessageType, message.type, 'message type'),
        channelIdentity: customerIdentity.channelIdentity,
        content,
        textApart: message.textApart,
        captionState: message.captionState,
        replyToExternalId,
        resentAt: message.resentAt,
        isLastAttempt,
        tainted
      })
      return
    }

    // Written BEFORE the provider is asked, and not after: a process that dies mid-send, or a job that stalls,
    // leaves the mark, and whatever the next attempt hears, the message may have gone. A database that cannot
    // take the mark fails the attempt before anything is sent.
    // (a closing message was marked by its claim, under the lock)
    if (!isClosing) await this.markInFlight(storeId, messageId)
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
      // The provider may have taken it: the answer is nonsense, the outcome is not known
      if (!result.success) {
        await this.fail(storeId, messageId, ErrorCodes.CHANNEL_MESSAGE_FAILED, false)
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
      // A provider that refuses in so many words did not take the message; a timeout or a network error
      // says nothing about whether it did
      const outcomeKnown = isDefinitiveRefusal(error)
      if (refused.retryable && !isLastAttempt) {
        // A refusal that was clean, with nothing before it that may have gone, leaves the message as it was; any
        // other keeps the mark: this attempt, or one before it, may have reached the provider
        if (outcomeKnown && !tainted) await this.clearInFlight(storeId, messageId)
        throw new SendAttemptFailed(refused.code, error)
      }
      await this.fail(storeId, messageId, refused.code, outcomeKnown && !tainted)
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
  //
  // The check and the mark of "may have gone" are one step under the lock of the conversation, the one
  // the Undo takes: a reply to a customer cannot be taken back, so an Undo that committed before this
  // lock is seen and the message is dropped, and one that comes after it finds a message past the point
  // of no return (the 10 s of the Undo and the 2 s of grace are over). The lock is held for these
  // statements only, never while the provider is asked, and the order is the one of every writer of a
  // thread: the conversation, then the message.
  private async claimClosingMessage(
    storeId: string,
    messageId: string,
    message: { conversation: { id: string }; createdAt: Date }
  ): Promise<boolean> {
    const conversationId = message.conversation.id
    try {
      return await this.prisma.transaction(async tx => {
        const conversation = await lockConversationForWrite(tx, storeId, conversationId)
        // The row of the message under its own lock, after the conversation's (the order of every writer)
        const rows = await tx.$queryRaw<{ delivery_status: string }[]>`
          SELECT delivery_status FROM messages
          WHERE id = ${messageId} AND store_id = ${storeId} FOR UPDATE`
        const stillQueued = rows[0]?.delivery_status === String(DeliveryStatus.QUEUED)
        // The window was open when the agent resolved; it may have closed during the wait, and free text
        // sent after it would only come back as a red bubble
        const stands =
          stillQueued &&
          conversation.status === String(ConversationStatus.RESOLVED) &&
          conversation.resolvedAt !== null &&
          conversation.resolvedAt <= message.createdAt &&
          (await this.window.isOpen(tx, storeId, conversationId))
        if (stands) {
          // What `markInFlight` writes before the provider is asked, written here with the check so that
          // nothing sits between them
          await tx.message.update({ where: { id: messageId }, data: { failureDefinitive: false } })
          return true
        }
        if (stillQueued) {
          await publishMessageChanged(this.events, tx, Events.MESSAGE_DELETED, storeId, messageId)
          await tx.message.delete({ where: { id: messageId } })
        }
        return false
      })
    } catch (error) {
      // The conversation went (or its store) after the job began: there is nothing to send. Any other
      // error, a lock that timed out among them, repeats the attempt
      if (error instanceof PlatformException && error.code === ErrorCodes.RESOURCE_NOT_FOUND) {
        return false
      }
      throw error
    }
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
        : // The first file went: the message is never one that did not go, so it cannot be thrown away
          { to: DeliveryStatus.FAILED, errorCode: failedWith, definitive: false }),
      ...(captionExternalId === undefined ? {} : { captionExternalId }),
      ...(captionState === undefined ? {} : { captionState })
    }
    let change: StatusChange =
      taken > 0 ? withoutId : { ...withoutId, channelMessageId: accepted.externalId }
    for (let attempt = 1; ; attempt += 1) {
      try {
        const applied = await this.status.apply(change)
        // A receipt moved the message past this state first: the id is still a fact about what was sent, and
        // receipts and echoes find the message by it
        if (!applied && change.channelMessageId !== undefined) {
          await this.prisma.client.message.updateMany({
            where: { id: messageId, storeId, channelMessageId: null },
            data: { channelMessageId: change.channelMessageId }
          })
        }
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
        sendErrorCode: true,
        channelMessageId: true,
        caption: true
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
      // Taken by the provider: sent, or already delivered or read by a receipt
      wasSent: SENT_STATES.includes(file.deliveryStatus ?? ''),
      // Failed on an earlier attempt of this send: it waits for the agent to send it again
      failedBefore: file.deliveryStatus === String(DeliveryStatus.FAILED),
      earlierErrorCode: file.sendErrorCode,
      channelMessageId: file.channelMessageId,
      caption: file.caption,
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
    sendAlbum: ChannelPlugin['sendAlbum']
    // What the plugin declared when it registered (a frozen copy): the rules of each kind and its album
    media: ReturnType<PluginRegistry['mediaOf']>
    // The text of a file whose kind has no place for one on the channel goes after it, as a message
    sendText: ChannelPlugin['sendMessage']
    conversationId: string
    channelType: string
    messageType: MessageType
    channelIdentity: string
    content: string
    // The text of the message is its own message after the last file (every file has only its own text)
    textApart: boolean
    // Where that text stands: only a text never tried (null) is sent by this send
    captionState: string | null
    replyToExternalId: string | null
    resentAt: Date | null
    isLastAttempt: boolean
    // An earlier attempt may have reached the provider (see `markInFlight`)
    tainted: boolean
  }): Promise<void> {
    const { storeId, messageId } = args
    // Outside the try below: a database error here is ours, not the provider's
    const files = await this.filesOf(storeId, messageId)
    if (files.length === 0) {
      this.logger.warn({ storeId, messageId }, 'a media message has no file')
      await this.fail(storeId, messageId, ErrorCodes.FILE_UNAVAILABLE, !args.tainted)
      return
    }
    // Every text is checked BEFORE the first file leaves, so that no album goes in part for a text the channel
    // would refuse. Only on a first attempt: a retry has files on their way already, and what they carried was
    // checked then.
    if (!args.tainted && !files.some(file => file.wasSent)) {
      const refused = files.some(file => {
        const text = this.captionOf(file, args.content, args.textApart)
        return (
          text !== '' &&
          // Apart, a file never carries its text as a message of its own: it is under it or it is refused
          captionProblemOf(args.channelType, args.messageType, text, !args.textApart) !== null
        )
      })
      if (refused) {
        await this.fail(storeId, messageId, ErrorCodes.CHANNEL_CAPABILITY_UNSUPPORTED, true)
        return
      }
    }
    // Written BEFORE the provider is asked (see the text path): a process that dies mid-send leaves the mark
    await this.markInFlight(storeId, messageId)
    // A file the provider took, on an earlier attempt or on this one, means the message has gone in part: it is
    // never thrown away as one that did not go
    let anySent = files.some(file => file.wasSent)
    // Whether every failure so far is a refusal in so many words (or a check that failed before anything was sent)
    let allRefused = true
    const failures: ErrorCode[] = []
    // What the first file got, from this attempt; the caption goes with it
    let firstAccepted: z.infer<typeof resultSchema> | null = null
    // The images of this message go together when the channel sends an album: the files an album took in (or left
    // out with their error) are done when the loop reaches them. It is switched off for the rest of the message
    // when the provider refuses an album, which then goes one by one.
    let albumOn =
      args.sendAlbum !== undefined &&
      args.media?.album !== undefined &&
      !carriesNoCaption(args.channelType, args.messageType)
    const handled = new Set<string>()
    for (const file of files) {
      if (handled.has(file.id)) continue
      if (file.wasSent) continue
      // Failed on an earlier attempt of this send, possibly with the outcome unknown: it is not sent again
      // behind the agent's back; "send again" puts it back in the queue. It still fails the message.
      if (file.failedBefore) {
        allRefused = false
        failures.push(
          (Object.values(ErrorCodes) as string[]).includes(file.earlierErrorCode ?? '')
            ? (file.earlierErrorCode as ErrorCode)
            : ErrorCodes.CHANNEL_MESSAGE_FAILED
        )
        continue
      }
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
      // The window of the channel is looked at at EVERY step: a conversation that closes in the middle of an
      // album sends what went, and the files that follow fail with the code of the window, in their order
      if (
        file.index > 0 &&
        !(await this.window.isOpen(this.prisma.client, storeId, args.conversationId))
      ) {
        await this.markFile(storeId, messageId, file.id, {
          failedWith: ErrorCodes.CHANNEL_WINDOW_EXPIRED
        })
        failures.push(ErrorCodes.CHANNEL_WINDOW_EXPIRED)
        continue
      }
      if (albumOn && args.sendAlbum !== undefined && args.media !== null) {
        // The text of the message rides with the album only where it is the text of the first file; any other text
        // keeps its file out of the album
        const picked = pickAlbum(
          files,
          file.index,
          args.media,
          candidate => this.captionOf(candidate, args.content, args.textApart),
          candidate => candidate.index === 0 && !args.textApart
        )
        if (picked.group.length >= 2) {
          // Checked against the rules of the channel before anything is stored or sent: that image fails alone
          for (const { file: refusedFile, code } of picked.rejected) {
            handled.add(refusedFile.id)
            await this.markFile(storeId, messageId, refusedFile.id, { failedWith: code })
            failures.push(code)
          }
          const clearable = allRefused && !args.tainted && !anySent
          const outcome = await this.sendAlbumGroup(
            { ...args, sendAlbum: args.sendAlbum },
            picked.group,
            clearable
          )
          if (outcome.kind === 'sent') {
            for (const member of picked.group) handled.add(member.id)
            anySent = true
            // All the files of the album at once: a write that fails half way would leave images that did go as
            // images that did not, and the next attempt would send them again
            await this.markAlbumSent(
              storeId,
              messageId,
              picked.group.map((member, position) => ({
                id: member.id,
                // The id of its own when the provider gave one for each; otherwise the id of the one message
                externalId: outcome.fileIds?.[position] ?? outcome.accepted.externalId
              }))
            )
            const head = picked.group[0]
            if (head !== undefined && head.index === 0) {
              if (!args.textApart) {
                await this.recordCaptionSafely(storeId, messageId, head, outcome.accepted)
              }
              firstAccepted = {
                ...outcome.accepted,
                externalId: outcome.fileIds?.[0] ?? outcome.accepted.externalId
              }
            }
            continue
          }
          if (outcome.kind === 'failed') {
            for (const member of picked.group) {
              handled.add(member.id)
              await this.markFile(storeId, messageId, member.id, { failedWith: outcome.code })
              failures.push(outcome.code)
            }
            if (!outcome.outcomeKnown) allRefused = false
            continue
          }
          // fallback: the images go one by one, this one first, unless the album already left it out with its error
          albumOn = false
          if (handled.has(file.id)) continue
        }
      }
      // The first attempt is keyed by the message and the place of the file; one the agent asked for again is
      // another attempt, or a provider that dedupes on the key would answer with the result of the first. A
      // message of one file keeps the key it always had.
      const text = this.captionOf(file, args.content, args.textApart)
      // Where the text of the message goes under the first file, a kind with no place for one sends it after the
      // file; the api refuses a text apart for any other file, and a text that reaches the plugin there is
      // refused by it, which fails that file in view. Where the text of the message is its own message after every
      // file (`textApart`), no file sends a text apart.
      const apart =
        !args.textApart && file.index === 0 && carriesNoCaption(args.channelType, args.messageType)
      const base = files.length === 1 ? messageId : `${messageId}-${file.position}`
      const idempotencyKey = args.resentAt === null ? base : `${base}-${args.resentAt.getTime()}`
      // An apart text has its state written BEFORE the file goes: a process that dies between the file and its
      // text leaves the text `unconfirmed`, which the agent can send again (a retry never sends a file twice)
      if (apart && text !== '') {
        await this.writeCaptionFacts(storeId, messageId, file, { state: CaptionState.UNCONFIRMED })
      }
      try {
        const result = resultSchema.safeParse(
          await withTimeout(
            args.sendMedia(args.context, {
              channelIdentity: args.channelIdentity,
              contentType: file.contentType,
              fileSize: file.size,
              openFile: file.open,
              filename: file.filename,
              // The text of this file goes with it, unless its kind has no place for one on the channel (then it
              // follows as a message of its own, below). It is the text of the message for the first file.
              ...(text === '' || apart ? {} : { caption: text }),
              ...(args.replyToExternalId === null || file.index !== 0
                ? {}
                : { replyToExternalId: args.replyToExternalId }),
              idempotencyKey
            }),
            // A file is uploaded before the message is posted: the budget is the upload's too
            OutboundLimits.MEDIA_SEND_TIMEOUT_MS
          )
        )
        // Sent twice would be worse than not sent: an answer that makes no sense is final for this file. The
        // provider may have taken it, though: the outcome is not known.
        if (!result.success) {
          allRefused = false
          await this.markFile(storeId, messageId, file.id, {
            failedWith: ErrorCodes.CHANNEL_MESSAGE_FAILED
          })
          failures.push(ErrorCodes.CHANNEL_MESSAGE_FAILED)
          continue
        }
        anySent = true
        await this.markFile(storeId, messageId, file.id, { sent: result.data })
        // Written now and not at the end: a later file can fail with a retry, and the id of this text would
        // be lost with this memory (its echo would be stored as a message of the owner). Only the text of the
        // message (under the first file) has a state to record: the others go with their file, or are refused
        if (file.index === 0) {
          // The text under the first file travels with it when the text of the message is apart: the state
          // of the message is that of the text of the message, which the file does not report
          if (!args.textApart) await this.recordCaptionSafely(storeId, messageId, file, result.data)
          firstAccepted = result.data
        }
        if (apart && text !== '') {
          await this.sendTextAfter(args, file, text, idempotencyKey)
        }
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
        // A provider that refuses in so many words did not take the file; a timeout or a network error says
        // nothing about whether it did
        const outcomeKnown = isDefinitiveRefusal(error)
        if (refused.retryable && !args.isLastAttempt) {
          // A clean refusal with nothing before it that may have gone leaves the message as it was
          if (outcomeKnown && allRefused && !args.tainted && !anySent) {
            await this.clearInFlight(storeId, messageId)
          }
          // Not `error` itself: the retry machinery logs it whole and keeps its text in Redis
          throw new SendAttemptFailed(refused.code, error)
        }
        if (!outcomeKnown) allRefused = false
        await this.markFile(storeId, messageId, file.id, { failedWith: refused.code })
        failures.push(refused.code)
      }
    }
    const first = files[0]
    // The text of the message goes last, as a message of its own, and only when every file has gone: a text that
    // overtakes a file that failed would reach the customer before it
    if (
      args.textApart &&
      first !== undefined &&
      args.content.trim() !== '' &&
      args.captionState === null &&
      failures.length === 0
    ) {
      await this.sendTextApart(args, first)
    }
    // The id of the message is the first file's, whichever attempt sent it: receipts and echoes find it there
    const firstId =
      firstAccepted?.externalId ?? (first?.wasSent === true ? first.channelMessageId : null)
    const [failure] = failures
    // Only a message none of whose files may have gone can be thrown away by an agent
    const definitive = allRefused && !args.tainted && !anySent
    // What the provider answered for the first file, or the id it gave on an earlier attempt
    const accepted =
      firstAccepted ??
      (firstId === null ? null : { externalId: firstId, status: DeliveryStatus.SENT as const })
    if (accepted === null) {
      // Nothing to record about the first file (it never went, or went with no id kept): only the state
      if (failure === undefined) {
        await this.status.apply({ storeId, messageId, to: DeliveryStatus.SENT })
      } else {
        await this.fail(storeId, messageId, failure, definitive)
      }
      return
    }
    await this.recordAccepted(storeId, messageId, args.connectionRowId, accepted, failure)
  }

  // The images of an album, in ONE call. The call is not repeatable on its own: a plugin has no key to make it so, and
  // a doubt (a timeout, a 5xx, an answer that makes no sense) is an unknown outcome, never a reason to send the images
  // again one by one. Only the provider's refusal in so many words, with nothing delivered, lets them go singly.
  // A failure that may be repeated while there are attempts left stops the send, as for one file.
  private async sendAlbumGroup(
    args: Parameters<OutboundSender['sendFiles']>[0] & {
      sendAlbum: NonNullable<ChannelPlugin['sendAlbum']>
    },
    group: readonly AttachmentToSend[],
    clearable: boolean
  ): Promise<AlbumOutcome> {
    const { storeId, messageId } = args
    const head = group[0]
    if (head === undefined)
      return { kind: 'failed', code: ErrorCodes.CHANNEL_MESSAGE_FAILED, outcomeKnown: false }
    const base = `${messageId}-album-${head.position}`
    const idempotencyKey = args.resentAt === null ? base : `${base}-${args.resentAt.getTime()}`
    const caption =
      head.index === 0 && !args.textApart ? this.captionOf(head, args.content, false) : ''
    try {
      const result = albumResultSchema.safeParse(
        await withTimeout(
          args.sendAlbum(args.context, {
            channelIdentity: args.channelIdentity,
            files: group.map(member => ({
              contentType: member.contentType,
              fileSize: member.size,
              openFile: member.open,
              filename: member.filename
            })),
            ...(caption === '' ? {} : { caption }),
            ...(args.replyToExternalId === null || head.index !== 0
              ? {}
              : { replyToExternalId: args.replyToExternalId }),
            idempotencyKey
          }),
          albumSendBudgetMs(group.length)
        )
      )
      // An answer that makes no sense: the provider may have taken the album, the outcome is not known
      if (!result.success) {
        return { kind: 'failed', code: ErrorCodes.CHANNEL_MESSAGE_FAILED, outcomeKnown: false }
      }
      const { fileExternalIds, ...accepted } = result.data
      // One id for each file, or none: a list of another length is not trusted, and the id of the message stands
      const fileIds = fileExternalIds?.length === group.length ? fileExternalIds : undefined
      return { kind: 'sent', accepted, fileIds }
    } catch (error) {
      const refused = refusalOf(error)
      // The message of the error may hold a token or a link: only its name and the provider's numbers are logged
      this.logger.warn(
        {
          pluginId: args.pluginId,
          messageId,
          files: group.length,
          code: refused.code,
          errorName: errorName(error),
          ...providerCodesOf(error)
        },
        'sending an album failed'
      )
      const outcomeKnown = isDefinitiveRefusal(error)
      if (refused.retryable && !args.isLastAttempt) {
        if (outcomeKnown && clearable) await this.clearInFlight(storeId, messageId)
        throw new SendAttemptFailed(refused.code, error)
      }
      // The provider answered that it did not take the album and nothing is to be waited for: the images go one
      // by one, each with the key it always had. Never on a doubt.
      // and only for a refusal of the message itself: a token that does not work, a closed window or a file the
      // channel does not take would be refused once for each image
      if (
        outcomeKnown &&
        refused.retryable !== true &&
        error instanceof PluginError &&
        error.refused &&
        error.code === ErrorCodes.CHANNEL_MESSAGE_FAILED
      ) {
        return { kind: 'fallback' }
      }
      return { kind: 'failed', code: refused.code, outcomeKnown }
    }
  }

  // The text under a file: the message's own for the first and the file's for the others, or the file's own for
  // every one where the text of the message is apart. Empty when none.
  private captionOf(file: AttachmentToSend, content: string, textApart: boolean): string {
    return (file.index === 0 && !textApart ? content : (file.caption ?? '')).trim()
  }

  // The text of the message as a message of its own after the last file. Its state is written BEFORE the call
  // (see `sendTextAfter`), so a send that dies in the middle never sends it twice; the window is looked at
  // first, because the files may have taken their time.
  private async sendTextApart(
    args: Parameters<OutboundSender['sendFiles']>[0],
    first: AttachmentToSend
  ): Promise<void> {
    const { storeId, messageId } = args
    if (!(await this.window.isOpen(this.prisma.client, storeId, args.conversationId))) {
      await this.writeFactsSafely(storeId, messageId, first, { state: CaptionState.FAILED })
      return
    }
    // The doubt is written before the call so that a death in between never sends the text twice. A write that
    // fails does not fail the files (they are sent): the text is then not sent, and it stays the agent's to send
    try {
      await this.writeCaptionFacts(storeId, messageId, first, { state: CaptionState.UNCONFIRMED })
    } catch (error) {
      this.logger.error(
        { messageId, errorName: errorName(error) },
        'the state of the text of the message was not written; the text was not sent'
      )
      return
    }
    const base = args.resentAt === null ? messageId : `${messageId}-${args.resentAt.getTime()}`
    await this.sendTextAfter(args, first, args.content.trim(), base)
  }

  // The id and the state of the text of the message (under the first file), as the plugin reported them: facts
  // about what was sent, written on the message whatever its delivery state. A caption that is `sent` is never
  // taken back.
  private async recordCaption(
    storeId: string,
    messageId: string,
    file: AttachmentToSend,
    accepted: z.infer<typeof resultSchema>
  ): Promise<void> {
    const externalId = accepted.metadata?.[ChannelResultMetadata.CAPTION_EXTERNAL_ID]
    const reported =
      externalId === undefined
        ? accepted.metadata?.[ChannelResultMetadata.CAPTION_STATE]
        : CaptionState.SENT
    if (externalId === undefined && reported === undefined) return
    await this.writeCaptionFacts(storeId, messageId, file, {
      ...(externalId === undefined ? {} : { externalId }),
      ...(reported === undefined ? {} : { state: reported })
    })
  }

  // For the text sent after a file: a write that fails is logged and never escapes (the file is sent)
  private async writeFactsSafely(
    storeId: string,
    messageId: string,
    file: AttachmentToSend,
    facts: { externalId?: string; state?: CaptionState }
  ): Promise<void> {
    try {
      await this.writeCaptionFacts(storeId, messageId, file, facts)
    } catch (error) {
      this.logger.error(
        { messageId, position: file.position, errorName: errorName(error) },
        'the state of the text under a file was not written'
      )
    }
  }

  // The facts of a text are written after the provider answered for the file: a failure to write them must
  // not become a failure of the file (it is sent already, and a retry would skip it and lose the text). The
  // state stays as it was, which the agent can see and resend.
  private async recordCaptionSafely(
    storeId: string,
    messageId: string,
    file: AttachmentToSend,
    accepted: z.infer<typeof resultSchema>
  ): Promise<void> {
    try {
      await this.recordCaption(storeId, messageId, file, accepted)
    } catch (error) {
      this.logger.error(
        { messageId, position: file.position, errorName: errorName(error) },
        'the state of the text under a file was not written'
      )
    }
  }

  private async writeCaptionFacts(
    storeId: string,
    messageId: string,
    file: AttachmentToSend,
    facts: { externalId?: string; state?: CaptionState }
  ): Promise<void> {
    const notSent =
      facts.state === CaptionState.SENT
        ? {}
        : { OR: [{ captionState: null }, { captionState: { not: CaptionState.SENT } }] }
    const data = {
      ...(facts.externalId === undefined ? {} : { captionChannelMessageId: facts.externalId }),
      ...(facts.state === undefined ? {} : { captionState: facts.state })
    }
    // The state of the text lives on the message: it is the text of the first file. A file after the first
    // has none to record (the channel carries its text with the file, or the api refused it)
    if (file.index !== 0) return
    await this.prisma.client.message.updateMany({
      where: { id: messageId, storeId, ...notSent },
      data
    })
  }

  // The text of a file whose kind has no place for one on the channel (an audio on WhatsApp), sent after the
  // file as a message of its own. A failure here is the text's alone: the file is sent, it is never sent again
  // for this, and the text is the agent's to send again. It is not retried by itself (the provider has no key
  // for it, so a call with no clear answer may have gone: `unconfirmed`). The text is never logged.
  private async sendTextAfter(
    args: {
      storeId: string
      messageId: string
      pluginId: string
      context: ReturnType<ChannelContextFactory['contextFor']>
      sendText: ChannelPlugin['sendMessage']
      channelIdentity: string
    },
    file: AttachmentToSend,
    text: string,
    fileKey: string
  ): Promise<void> {
    const { storeId, messageId } = args
    try {
      const answer = resultSchema.safeParse(
        await withTimeout(
          args.sendText(args.context, {
            channelIdentity: args.channelIdentity,
            content: text,
            idempotencyKey: `${fileKey}-caption`
          }),
          OutboundLimits.SEND_TIMEOUT_MS
        )
      )
      if (!answer.success) {
        await this.writeFactsSafely(storeId, messageId, file, { state: CaptionState.UNCONFIRMED })
        return
      }
      await this.writeFactsSafely(storeId, messageId, file, {
        externalId: answer.data.externalId,
        state: CaptionState.SENT
      })
    } catch (error) {
      this.logger.warn(
        {
          pluginId: args.pluginId,
          messageId,
          position: file.position,
          errorName: errorName(error),
          length: Array.from(text).length
        },
        'sending the text under a file failed'
      )
      await this.writeFactsSafely(storeId, messageId, file, {
        state: isDefinitiveRefusal(error) ? CaptionState.FAILED : CaptionState.UNCONFIRMED
      })
    }
  }

  // The files of an album the provider took, written in one transaction: all of them or none. Tried a few times, as a
  // single file is, because nothing here may make the album be sent again.
  private async markAlbumSent(
    storeId: string,
    messageId: string,
    files: readonly { id: string; externalId: string }[]
  ): Promise<void> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        await this.prisma.transaction(async tx => {
          for (const file of files) {
            await tx.media.updateMany({
              // A file that is already sent, or that a receipt moved on, is never taken back
              where: {
                id: file.id,
                storeId,
                messageId,
                OR: [
                  { deliveryStatus: null },
                  { deliveryStatus: { in: [DeliveryStatus.QUEUED, DeliveryStatus.FAILED] } }
                ]
              },
              data: {
                deliveryStatus: DeliveryStatus.SENT,
                channelMessageId: file.externalId,
                sentAt: new Date(),
                sendErrorCode: null
              }
            })
          }
        })
        return
      } catch (error) {
        if (attempt >= OutboundLimits.WRITE_ATTEMPTS) throw error
        await delay(OutboundLimits.WRITE_RETRY_DELAY_MS * attempt)
      }
    }
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
            // A file the provider took, or a receipt moved on, is never taken back
            OR: [
              { deliveryStatus: null },
              { deliveryStatus: { in: [DeliveryStatus.QUEUED, DeliveryStatus.FAILED] } }
            ]
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

  // `definitive`: the provider is known not to have taken the message (a refusal, or a check that failed
  // before anything was sent). Only then can an agent throw the reply away.
  private async fail(
    storeId: string,
    messageId: string,
    errorCode: ErrorCode,
    definitive: boolean
  ): Promise<void> {
    await this.status.apply({
      storeId,
      messageId,
      to: DeliveryStatus.FAILED,
      errorCode,
      definitive
    })
  }

  // The provider is about to be asked: the message is marked as one that may have gone (`failureDefinitive`
  // false while it is queued) until an answer says otherwise
  private async markInFlight(storeId: string, messageId: string): Promise<void> {
    await this.prisma.client.message.updateMany({
      where: { id: messageId, storeId, deliveryStatus: DeliveryStatus.QUEUED },
      data: { failureDefinitive: false }
    })
  }

  // The attempt was refused in so many words and nothing before it may have gone: the mark is taken off
  private async clearInFlight(storeId: string, messageId: string): Promise<void> {
    await this.prisma.client.message.updateMany({
      where: { id: messageId, storeId, deliveryStatus: DeliveryStatus.QUEUED },
      data: { failureDefinitive: null }
    })
  }
}
