import { Injectable } from '@nestjs/common'
import { PinoLogger } from 'nestjs-pino'

import {
  CONNECTION_ROW_SELECT,
  ChannelContextFactory,
  errorName,
  withTimeout
} from '@platform/channels/connections'
import { PrismaService } from '@platform/core/database'
import {
  ChannelConnectionStatus,
  DeliveryStatus,
  isInstallationActive,
  OutboundLimits
} from '@platform/core/domain'
import { ErrorCodes, type ErrorCode } from '@platform/core/errors'
import { enumValueOf } from '@platform/core/messaging'
import type { SendOutboundDeleteJob, SendOutboundEditJob } from '@platform/core/queues'
import { PluginRegistry } from '@platform/plugins/runtime'
import type { ChannelContext, ChannelPlugin } from '@platform/plugins/sdk'

import { MessageChangeStatusWriter } from './message-change-status.writer'
import { refusalOf, SendAttemptFailed } from './send-refusal'

const MESSAGE_SELECT = {
  channelMessageId: true,
  deletedAt: true,
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

  private read(storeId: string, messageId: string) {
    return this.prisma.client.message.findFirst({
      where: { id: messageId, storeId },
      select: MESSAGE_SELECT
    })
  }

  private prepare(
    message: NonNullable<Awaited<ReturnType<MessageChangeSender['read']>>>,
    method: 'editMessage' | 'deleteMessage',
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
    return {
      plugin,
      ctx: this.contexts.contextFor(connection),
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
