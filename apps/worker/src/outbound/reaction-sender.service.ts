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
  AuthorType,
  ChannelConnectionStatus,
  DeliveryStatus,
  isInstallationActive,
  OutboundLimits
} from '@platform/core/domain'
import { ErrorCodes, type ErrorCode } from '@platform/core/errors'
import { enumValueOf } from '@platform/core/messaging'
import type { SendOutboundReactionJob } from '@platform/core/queues'
import { PluginRegistry } from '@platform/plugins/runtime'

import { ReactionStatusWriter } from './reaction-status.writer'
import { refusalOf, SendAttemptFailed } from './send-refusal'

// The worker half of an agent's reaction: reads the reaction as it stands now, asks the plugin of the
// channel to send it, and settles it as sent or failed so that the thread says whether the customer got
// it. A job whose reaction was changed again since is left to the job of the change.
@Injectable()
export class ReactionSender {
  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: PluginRegistry,
    private readonly contexts: ChannelContextFactory,
    private readonly status: ReactionStatusWriter,
    private readonly logger: PinoLogger
  ) {
    this.logger.setContext(ReactionSender.name)
  }

  // Throws when the attempt should be repeated; returns when the reaction is settled
  async send(job: SendOutboundReactionJob, isLastAttempt: boolean): Promise<void> {
    const { storeId, messageId, userId } = job
    const reaction = await this.prisma.client.messageReaction.findFirst({
      where: { storeId, messageId, authorType: AuthorType.AGENT, userId },
      select: { emoji: true, deliveryStatus: true, updatedAt: true }
    })
    // A reaction that is there and is not waiting was sent or failed already; one changed since this job
    // was made has a job of its own
    if (
      reaction !== null &&
      (enumValueOf(DeliveryStatus, reaction.deliveryStatus, 'reaction delivery') !==
        DeliveryStatus.QUEUED ||
        reaction.updatedAt.getTime() !== job.version)
    ) {
      return
    }
    const emoji = reaction?.emoji ?? null
    const settle = (errorCode: ErrorCode | null): Promise<void> =>
      this.status.settle({ ...job, errorCode, expectedVersion: reaction?.updatedAt ?? null })

    const message = await this.prisma.client.message.findFirst({
      where: { id: messageId, storeId },
      select: {
        channelMessageId: true,
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
      }
    })
    if (message?.channelMessageId == null) {
      await settle(ErrorCodes.CHANNEL_MESSAGE_FAILED)
      return
    }
    const { channelConnection: connection, customerIdentity } = message.conversation
    const connectionStatus = isInstallationActive(connection.installation)
      ? connection.status
      : ChannelConnectionStatus.DISCONNECTED
    if (
      enumValueOf(ChannelConnectionStatus, connectionStatus, 'channel connection status') ===
      ChannelConnectionStatus.DISCONNECTED
    ) {
      await settle(ErrorCodes.CHANNEL_NOT_CONNECTED)
      return
    }
    const plugin = this.registry.find(connection.pluginId)
    if (plugin === undefined) {
      // A registry that is still filling is not a connection that is gone: only the last attempt gives up
      if (!isLastAttempt) throw new Error('the plugin of the connection is not registered')
      await settle(ErrorCodes.CHANNEL_NOT_CONNECTED)
      return
    }
    if (plugin.sendReaction === undefined) {
      await settle(ErrorCodes.CHANNEL_CAPABILITY_UNSUPPORTED)
      return
    }
    try {
      await withTimeout(
        plugin.sendReaction(this.contexts.contextFor(connection), {
          channelIdentity: customerIdentity.channelIdentity,
          targetExternalId: message.channelMessageId,
          emoji
        }),
        OutboundLimits.SEND_TIMEOUT_MS
      )
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
        'sending a reaction failed'
      )
      if (refused.retryable && !isLastAttempt)
        throw new SendAttemptFailed(refused.code, error, 'a reaction')
      await settle(refused.code)
      return
    }
    await settle(null)
  }
}
