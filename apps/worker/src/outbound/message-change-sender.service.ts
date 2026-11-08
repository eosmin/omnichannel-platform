import { Injectable } from '@nestjs/common'
import { PinoLogger } from 'nestjs-pino'
import { z } from 'zod'

import {
  CONNECTION_ROW_SELECT,
  ChannelContextFactory,
  CredentialsUnreadableError,
  errorName,
  withTimeout
} from '@platform/channels/connections'
import { PrismaService } from '@platform/core/database'
import {
  CaptionState,
  ChannelConnectionStatus,
  DeliveryStatus,
  isInstallationActive,
  OutboundLimits
} from '@platform/core/domain'
import { ErrorCodes, type ErrorCode } from '@platform/core/errors'
import { enumValueOf } from '@platform/core/messaging'
import type {
  SendOutboundCaptionJob,
  SendOutboundDeleteJob,
  SendOutboundEditJob
} from '@platform/core/queues'
import { PluginRegistry } from '@platform/plugins/runtime'
import { type ChannelContext, type ChannelPlugin, PluginError } from '@platform/plugins/sdk'

import {
  MessageChangeStatusWriter,
  type CaptionSettlement,
  type MediaCaptionSettlement
} from './message-change-status.writer'
import { refusalOf, SendAttemptFailed } from './send-refusal'

const MESSAGE_SELECT = {
  channelMessageId: true,
  deletedAt: true,
  version: true,
  content: true,
  captionState: true,
  pendingContent: true,
  editStatus: true,
  deleteStatus: true,
  conversation: {
    select: {
      customerIdentity: { select: { channelIdentity: true } },
      channelConnection: {
        select: {
          ...CONNECTION_ROW_SELECT,
          installation: { select: { status: true, plugin: { select: { status: true } } } }
        }
      }
    }
  }
} as const

// What a call to the plugin needs, or the code that settles the request when it cannot be made
type Prepared =
  | { plugin: ChannelPlugin; ctx: ChannelContext; channelIdentity: string; externalId: string }
  | { refusedWith: ErrorCode }

// What the channel answered to a text sent again: its id, or nothing usable
const captionResultSchema = z.object({ externalId: z.string().min(1).max(255) })

// The worker half of an agent's edit or deletion of a message the customer has: reads the request as
// it stands now, asks the plugin of the channel, and settles it as taken or refused so that the thread
// says which. A request that is no longer waiting (settled, or made again) is left alone.
@Injectable()
export class MessageChangeSender {
  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: PluginRegistry,
    private readonly contexts: ChannelContextFactory,
    private readonly status: MessageChangeStatusWriter,
    private readonly logger: PinoLogger
  ) {
    this.logger.setContext(MessageChangeSender.name)
  }

  // Throws when the attempt should be repeated; returns when the request is settled
  async sendEdit(job: SendOutboundEditJob, isLastAttempt: boolean): Promise<void> {
    const { storeId, messageId } = job
    const message = await this.read(storeId, messageId)
    const content = message?.pendingContent
    if (
      message === null ||
      content === null ||
      content === undefined ||
      message.editStatus !== DeliveryStatus.QUEUED.valueOf()
    ) {
      return
    }
    const settle = (errorCode: ErrorCode | null): Promise<void> =>
      this.status.settleEdit({ storeId, messageId, pendingContent: content, errorCode })
    // Deleted since the agent asked: nothing to edit at the provider, and the request is dropped
    if (message.deletedAt !== null) return settle(null)
    const prepared = this.prepare(message, 'editMessage', isLastAttempt)
    if ('refusedWith' in prepared) return settle(prepared.refusedWith)
    await this.call(job, 'an edit', isLastAttempt, settle, prepared.plugin.id, () =>
      prepared.plugin.editMessage?.(prepared.ctx, {
        channelIdentity: prepared.channelIdentity,
        targetExternalId: prepared.externalId,
        content
      })
    )
  }

  async sendDeletion(job: SendOutboundDeleteJob, isLastAttempt: boolean): Promise<void> {
    const { storeId, messageId } = job
    const message = await this.read(storeId, messageId)
    if (
      message === null ||
      message.deletedAt !== null ||
      message.deleteStatus !== DeliveryStatus.QUEUED.valueOf()
    ) {
      return
    }
    const settle = (errorCode: ErrorCode | null): Promise<void> =>
      this.status.settleDeletion({ storeId, messageId, errorCode })
    const prepared = this.prepare(message, 'deleteMessage', isLastAttempt)
    if ('refusedWith' in prepared) return settle(prepared.refusedWith)
    await this.call(job, 'a deletion', isLastAttempt, settle, prepared.plugin.id, () =>
      prepared.plugin.deleteMessage?.(prepared.ctx, {
        channelIdentity: prepared.channelIdentity,
        targetExternalId: prepared.externalId
      })
    )
  }

  // The text under a file that an agent asked to send again, as a message of its own. Nothing is read
  // from the provider's side to make the second call safe (Meta has no idempotency key), so a call that may
  // have gone out is never repeated here: it ends `unconfirmed`, and the echo of the owner settles it.
  async sendCaption(job: SendOutboundCaptionJob, isLastAttempt: boolean): Promise<void> {
    const { storeId, messageId } = job
    if (job.mediaId !== undefined) return this.sendMediaCaption(job, job.mediaId, isLastAttempt)
    const message = await this.read(storeId, messageId)
    // Not waiting, or waiting for a newer request than this job's: a late job sends nothing
    if (
      message === null ||
      message.captionState !== CaptionState.QUEUED ||
      message.version !== job.version
    ) {
      return
    }
    const settle = (outcome: CaptionSettlement['outcome']): Promise<void> =>
      this.settleCaption({ storeId, messageId, version: job.version, outcome })
    const content = message.content
    // Nothing to send any more (deleted, or the text is gone): the request ends without a call
    if (message.deletedAt !== null || content === null || content === '') {
      return settle({ state: CaptionState.FAILED })
    }
    const prepared = this.prepare(message, 'sendMessage', isLastAttempt)
    // Nothing was sent: the text is where it was
    if ('refusedWith' in prepared) return settle({ state: CaptionState.FAILED })
    let externalId: string
    try {
      const answer = await withTimeout(
        prepared.plugin.sendMessage(prepared.ctx, {
          channelIdentity: prepared.channelIdentity,
          content,
          idempotencyKey: `caption-${messageId}-${job.version}`
        }),
        OutboundLimits.SEND_TIMEOUT_MS
      )
      const parsed = captionResultSchema.safeParse(answer)
      // A 2xx the core cannot read may still have delivered the text
      if (!parsed.success) return settle({ state: CaptionState.UNCONFIRMED })
      externalId = parsed.data.externalId
    } catch (error) {
      const refused = refusalOf(error)
      // A refusal of the provider did not deliver the text; a timeout, a 5xx or any other error may have
      const outcomeUnknown = !(error instanceof PluginError) || error.outcomeUnknown
      this.logger.warn(
        {
          pluginId: prepared.plugin.id,
          messageId,
          code: refused.code,
          errorName: errorName(error)
        },
        'sending the text under a file failed'
      )
      if (!outcomeUnknown && refused.retryable && !isLastAttempt) {
        throw new SendAttemptFailed(refused.code, error, 'a caption')
      }
      return settle({ state: outcomeUnknown ? CaptionState.UNCONFIRMED : CaptionState.FAILED })
    }
    return settle({ state: CaptionState.SENT, externalId })
  }

  // The text under one file of a message, sent again as a message of its own: its state and its id are the
  // ones of the file, and the version of the message says which request this job is
  private async sendMediaCaption(
    job: SendOutboundCaptionJob,
    mediaId: string,
    isLastAttempt: boolean
  ): Promise<void> {
    const { storeId, messageId } = job
    const message = await this.read(storeId, messageId)
    const file = await this.prisma.client.media.findFirst({
      where: { id: mediaId, storeId, messageId },
      select: { caption: true, captionState: true }
    })
    // Not waiting, or waiting for a newer request than this job's: a late job sends nothing
    if (
      message === null ||
      file === null ||
      file.captionState !== CaptionState.QUEUED ||
      message.version !== job.version
    ) {
      return
    }
    const settle = (outcome: CaptionSettlement['outcome']): Promise<void> =>
      this.settleMediaCaption({ storeId, messageId, mediaId, version: job.version, outcome })
    const text = file.caption
    if (message.deletedAt !== null || text === null || text === '') {
      return settle({ state: CaptionState.FAILED })
    }
    const prepared = this.prepare(message, 'sendMessage', isLastAttempt)
    if ('refusedWith' in prepared) return settle({ state: CaptionState.FAILED })
    let externalId: string
    try {
      const answer = await withTimeout(
        prepared.plugin.sendMessage(prepared.ctx, {
          channelIdentity: prepared.channelIdentity,
          content: text,
          idempotencyKey: `caption-${messageId}-${mediaId}-${job.version}`
        }),
        OutboundLimits.SEND_TIMEOUT_MS
      )
      const parsed = captionResultSchema.safeParse(answer)
      if (!parsed.success) return settle({ state: CaptionState.UNCONFIRMED })
      externalId = parsed.data.externalId
    } catch (error) {
      const refused = refusalOf(error)
      const outcomeUnknown = !(error instanceof PluginError) || error.outcomeUnknown
      // Only the length of the text, never the text
      this.logger.warn(
        {
          pluginId: prepared.plugin.id,
          messageId,
          code: refused.code,
          errorName: errorName(error),
          length: Array.from(text).length
        },
        'sending the text under a file failed'
      )
      if (!outcomeUnknown && refused.retryable && !isLastAttempt) {
        throw new SendAttemptFailed(refused.code, error, 'a caption')
      }
      return settle({ state: outcomeUnknown ? CaptionState.UNCONFIRMED : CaptionState.FAILED })
    }
    return settle({ state: CaptionState.SENT, externalId })
  }

  private async settleMediaCaption(settlement: MediaCaptionSettlement): Promise<void> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.status.settleMediaCaption(settlement)
      } catch (error) {
        if (attempt >= OutboundLimits.WRITE_ATTEMPTS) {
          this.logger.error(
            { messageId: settlement.messageId, errorName: errorName(error) },
            'the state of the text under a file was not written; the sweep marks it unconfirmed'
          )
          return
        }
        await new Promise(resolve =>
          setTimeout(resolve, OutboundLimits.WRITE_RETRY_DELAY_MS * attempt)
        )
      }
    }
  }

  // Once the call was made, a write that fails is tried a few times and never makes the job call the
  // provider a second time: if it still fails, the state stays `queued` and the sweep marks it
  // `unconfirmed`, which says to check the chat
  private async settleCaption(settlement: CaptionSettlement): Promise<void> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.status.settleCaption(settlement)
      } catch (error) {
        if (attempt >= OutboundLimits.WRITE_ATTEMPTS) {
          this.logger.error(
            { messageId: settlement.messageId, errorName: errorName(error) },
            'the state of the text under a file was not written; the sweep marks it unconfirmed'
          )
          return
        }
        await new Promise(resolve =>
          setTimeout(resolve, OutboundLimits.WRITE_RETRY_DELAY_MS * attempt)
        )
      }
    }
  }

  private read(storeId: string, messageId: string) {
    return this.prisma.client.message.findFirst({
      where: { id: messageId, storeId },
      select: MESSAGE_SELECT
    })
  }

  private prepare(
    message: NonNullable<Awaited<ReturnType<MessageChangeSender['read']>>>,
    method: 'editMessage' | 'deleteMessage' | 'sendMessage',
    isLastAttempt: boolean
  ): Prepared {
    if (message.channelMessageId === null) return { refusedWith: ErrorCodes.CHANNEL_MESSAGE_FAILED }
    const { channelConnection: connection, customerIdentity } = message.conversation
    const connectionStatus = isInstallationActive(connection.installation)
      ? connection.status
      : ChannelConnectionStatus.DISCONNECTED
    if (
      enumValueOf(ChannelConnectionStatus, connectionStatus, 'channel connection status') ===
      ChannelConnectionStatus.DISCONNECTED
    ) {
      return { refusedWith: ErrorCodes.CHANNEL_NOT_CONNECTED }
    }
    const plugin = this.registry.find(connection.pluginId)
    if (plugin === undefined) {
      // A registry that is still filling is not a connection that is gone: only the last attempt gives up
      if (!isLastAttempt) throw new Error('the plugin of the connection is not registered')
      return { refusedWith: ErrorCodes.CHANNEL_NOT_CONNECTED }
    }
    if (plugin[method] === undefined) {
      return { refusedWith: ErrorCodes.CHANNEL_CAPABILITY_UNSUPPORTED }
    }
    // Credentials that cannot be opened may be a worker with another key for a while: the retries
    // come first, and only the last attempt gives up
    let ctx
    try {
      ctx = this.contexts.contextFor(connection)
    } catch (error) {
      if (error instanceof CredentialsUnreadableError && isLastAttempt) {
        return { refusedWith: ErrorCodes.CHANNEL_CREDENTIALS_INVALID }
      }
      throw error
    }
    return {
      plugin,
      ctx,
      channelIdentity: customerIdentity.channelIdentity,
      externalId: message.channelMessageId
    }
  }

  private async call(
    job: { messageId: string },
    what: 'an edit' | 'a deletion',
    isLastAttempt: boolean,
    settle: (errorCode: ErrorCode | null) => Promise<void>,
    pluginId: string,
    run: () => Promise<void> | undefined
  ): Promise<void> {
    try {
      await withTimeout(run() ?? Promise.resolve(), OutboundLimits.SEND_TIMEOUT_MS)
    } catch (error) {
      const refused = refusalOf(error)
      // The message of the error may hold a token: only its name is logged, and none of it is stored
      this.logger.warn(
        { pluginId, messageId: job.messageId, code: refused.code, errorName: errorName(error) },
        `sending ${what} failed`
      )
      if (refused.retryable && !isLastAttempt)
        throw new SendAttemptFailed(refused.code, error, what)
      await settle(refused.code)
      return
    }
    await settle(null)
  }
}
