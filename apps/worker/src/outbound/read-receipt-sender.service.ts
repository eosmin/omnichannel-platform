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
  isInstallationActive,
  OutboundLimits
} from '@platform/core/domain'
import { enumValueOf } from '@platform/core/messaging'
import type { SendOutboundReadReceiptJob } from '@platform/core/queues'
import { PluginRegistry } from '@platform/plugins/runtime'

import { refusalOf, SendAttemptFailed } from './send-refusal'

// The worker half of the blue ticks: asks the plugin of the channel to mark the message as read. It
// stores nothing and shows nothing, so a refusal is only logged: the read state of the platform and the
// state of the connection are not its to change.
@Injectable()
export class ReadReceiptSender {
  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: PluginRegistry,
    private readonly contexts: ChannelContextFactory,
    private readonly logger: PinoLogger
  ) {
    this.logger.setContext(ReadReceiptSender.name)
  }

  // Throws when the attempt should be repeated; returns when there is nothing more to do
  async send(job: SendOutboundReadReceiptJob, isLastAttempt: boolean): Promise<void> {
    const { storeId, conversationId, messageId } = job
    const message = await this.prisma.client.message.findFirst({
      where: {
        id: messageId,
        storeId,
        conversationId,
        authorType: AuthorType.CUSTOMER,
        // The customer may take the message back between the read and this job
        deletedAt: null
      },
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
    if (message?.channelMessageId == null) return
    const { channelConnection: connection, customerIdentity } = message.conversation
    const connectionStatus = isInstallationActive(connection.installation)
      ? connection.status
      : ChannelConnectionStatus.DISCONNECTED
    if (
      enumValueOf(ChannelConnectionStatus, connectionStatus, 'channel connection status') ===
      ChannelConnectionStatus.DISCONNECTED
    ) {
      return
    }
    const plugin = this.registry.find(connection.pluginId)
    if (plugin === undefined) {
      // A registry that is still filling is not a connection that is gone
      if (!isLastAttempt) throw new Error('the plugin of the connection is not registered')
      return
    }
    // A plugin that does not declare READ_RECEIPTS has no markAsRead: there is nobody to tell
    if (plugin.markAsRead === undefined) return
    try {
      await withTimeout(
        plugin.markAsRead(this.contexts.contextFor(connection), {
          channelIdentity: customerIdentity.channelIdentity,
          externalId: message.channelMessageId
        }),
        OutboundLimits.SEND_TIMEOUT_MS
      )
    } catch (error) {
      const refused = refusalOf(error)
      // The message of the error may hold a token: only its name is logged
      this.logger.warn(
        {
          pluginId: connection.pluginId,
          messageId,
          code: refused.code,
          errorName: errorName(error)
        },
        'sending a read receipt failed'
      )
      if (refused.retryable && !isLastAttempt) {
        throw new SendAttemptFailed(refused.code, error, 'a read receipt')
      }
    }
  }
}
