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
  isInstallationActive,
  OutboundLimits
} from '@platform/core/domain'
import { enumValueOf } from '@platform/core/messaging'
import type { SendOutboundTypingJob } from '@platform/core/queues'
import { readStorePreferences } from '@platform/core/store-preferences'
import { PluginRegistry } from '@platform/plugins/runtime'

import { providerCodesOf } from './provider-codes'
import { refusalOf } from './send-refusal'
import { lastInboundOf, lastInboundQuery } from './typing-inbound'

// The worker half of "an agent is typing": asks the plugin of the channel to show it to the customer.
// It stores nothing and is never repeated, so a failure is only logged. The memory of the newest job of
// each conversation is per process, like the api's: enough for one worker.
@Injectable()
export class TypingSender {
  // The newest job seen per conversation, in the order it was seen (a set deletes before it sets)
  private readonly latest = new Map<string, { at: number; seenAt: number }>()

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: PluginRegistry,
    private readonly contexts: ChannelContextFactory,
    private readonly logger: PinoLogger
  ) {
    this.logger.setContext(TypingSender.name)
  }

  async send(job: SendOutboundTypingJob): Promise<void> {
    const { conversationId, active, at } = job
    const now = Date.now()
    // A start that waited too long shows what is no longer so; a stop is always worth sending, since the
    // indicator it takes away is still on. A time from the future is a bad job: it would hold the marker
    // of the conversation ahead of every real one.
    if (at - now > OutboundLimits.TYPING_STALE_MS) return
    if (active && now - at > OutboundLimits.TYPING_STALE_MS) return
    // One that a newer job of the conversation overtook (the worker runs several at once) would undo it.
    // The api stamps each job later than the one before, so a tie is the same job twice.
    const seen = this.latest.get(conversationId)
    if (seen !== undefined && at <= seen.at) return
    this.remember(conversationId, at, now)
    try {
      await this.deliver(job)
    } catch (error) {
      // Nobody is waiting for the answer and a retry would show the wrong thing: the failure of the
      // database or of the plugin is only logged. The message of an error may hold a token: only its
      // name is.
      this.logger.debug(
        {
          conversationId,
          code: refusalOf(error).code,
          errorName: errorName(error),
          ...providerCodesOf(error)
        },
        'sending a typing indicator failed'
      )
    }
  }

  private async deliver(job: SendOutboundTypingJob): Promise<void> {
    const { storeId, conversationId, active } = job
    const conversation = await this.prisma.client.conversation.findFirst({
      where: { id: conversationId, storeId },
      select: {
        customerIdentity: { select: { channelIdentity: true } },
        channelConnection: {
          select: {
            ...CONNECTION_ROW_SELECT,
            installation: { select: { status: true, plugin: { select: { status: true } } } }
          }
        }
      }
    })
    if (conversation === null) return
    const { channelConnection: connection, customerIdentity } = conversation
    const connectionStatus = isInstallationActive(connection.installation)
      ? connection.status
      : ChannelConnectionStatus.DISCONNECTED
    if (
      enumValueOf(ChannelConnectionStatus, connectionStatus, 'channel connection status') ===
      ChannelConnectionStatus.DISCONNECTED
    ) {
      return
    }
    // A plugin that does not declare TYPING_INDICATOR has no sendTypingIndicator: nobody to tell
    const plugin = this.registry.find(connection.pluginId)
    if (plugin?.sendTypingIndicator === undefined) return
    // Only a start has a message to answer. The read comes after the check of the plugin, so a channel
    // that needs none costs no query; the switch of the store decides whether the indicator may mark
    // the message as read (some providers show it through the read receipt).
    const lastInbound = active ? await this.lastInbound(storeId, conversationId) : undefined
    await withTimeout(
      plugin.sendTypingIndicator(this.contexts.contextFor(connection), {
        channelIdentity: customerIdentity.channelIdentity,
        active,
        ...(lastInbound === undefined ? {} : { lastInbound })
      }),
      OutboundLimits.SEND_TIMEOUT_MS
    )
  }

  private async lastInbound(storeId: string, conversationId: string) {
    const [row, settings] = await Promise.all([
      this.prisma.client.message.findFirst(lastInboundQuery(storeId, conversationId)),
      this.prisma.client.storeSettings.findUnique({
        where: { storeId },
        select: { preferences: true }
      })
    ])
    return lastInboundOf(row, readStorePreferences(settings?.preferences ?? {}).sendReadReceipts)
  }

  // `seenAt` is the clock of this process, so insertion order is time order and the old ones are in front
  private remember(conversationId: string, at: number, seenAt: number): void {
    this.latest.delete(conversationId)
    this.latest.set(conversationId, { at, seenAt })
    for (const [id, entry] of this.latest) {
      if (seenAt - entry.seenAt <= OutboundLimits.TYPING_STALE_MS) break
      this.latest.delete(id)
    }
  }
}
