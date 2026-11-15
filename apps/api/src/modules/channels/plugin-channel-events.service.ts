import { Injectable } from '@nestjs/common'
import { EventEmitter2 } from '@nestjs/event-emitter'
import type { Counter } from '@prometheus-io/client'
import { PinoLogger } from 'nestjs-pino'

import { PrismaService } from '@platform/core/database'
import {
  ChannelConnectionStatus,
  ConversationHiddenStatuses,
  PluginEventRejectionReasons,
  type PluginEventRejectionReason
} from '@platform/core/domain'
import { Events } from '@platform/core/events'
import { MetricNames } from '@platform/core/metrics'
import { InjectMetric } from '@platform/core/metrics-module'
import { PluginRegistry, type ValidRemoteChannelEvent } from '@platform/plugins/runtime'
import {
  ChannelCapability,
  type ChannelCapabilityType,
  ChannelEventTypes
} from '@platform/plugins/sdk'

import { InboundEventQueue } from './inbound-event-queue.service'
import { connectionNotFound, type PluginCaller } from './plugin-channel-connections.service'
import { PluginChannelLimitsStore } from './plugin-channel-limits.store'

// The events that are about a message the platform sent
const STATUS_EVENTS: readonly string[] = [
  ChannelEventTypes.MESSAGE_SENT,
  ChannelEventTypes.MESSAGE_DELIVERED,
  ChannelEventTypes.MESSAGE_READ,
  ChannelEventTypes.MESSAGE_FAILED
]

// What the plugin must have declared for the platform to take the event
const CAPABILITY_OF: Readonly<Record<string, ChannelCapabilityType>> = {
  [ChannelEventTypes.CUSTOMER_TYPING]: ChannelCapability.CUSTOMER_TYPING,
  [ChannelEventTypes.MESSAGE_DELIVERED]: ChannelCapability.DELIVERY_RECEIPTS,
  [ChannelEventTypes.MESSAGE_READ]: ChannelCapability.READ_RECEIPTS
}

// `POST /plugin-api/channel/events` (TDD_10 §6.7.5, scope `channel:events`): what the customers of a remote channel write and what
// happened to what the platform sent. The plugin normalises, the platform does what it does for an official channel: each event goes
// to the INBOUND queue. What is decided here is what the plugin may NOT do:
//   - name a connection that is not one of its installation: the whole request is a 404, the same one as for a connection that
//     does not exist, and nothing is queued;
//   - say something about a message that is not on one of its own connections: that event is dropped and counted;
//   - use an event type its channel never declared the capability for: dropped and counted.
// The store is never read from the request: the connection row says it, and that row hangs from the installation of the key.
@Injectable()
export class PluginChannelEventsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: PluginRegistry,
    private readonly queue: InboundEventQueue,
    private readonly limits: PluginChannelLimitsStore,
    private readonly emitter: EventEmitter2,
    @InjectMetric(MetricNames.PLUGIN_EVENT_REJECTED) private readonly rejected: Counter<string>,
    private readonly logger: PinoLogger
  ) {
    this.logger.setContext(PluginChannelEventsService.name)
  }

  // How many events were taken: those dropped are not counted
  async ingest(caller: PluginCaller, events: readonly ValidRemoteChannelEvent[]): Promise<number> {
    // First, so that a plugin past its ceiling costs nothing else
    await this.limits.takeEvents(caller.installationId, events.length)

    const ids = [...new Set(events.map(event => event.connectionId))]
    const connections = await this.prisma.client.channelConnection.findMany({
      where: {
        pluginId: caller.pluginId,
        storeId: caller.storeId,
        installationId: caller.installationId,
        connectionId: { in: ids },
        status: { not: ChannelConnectionStatus.DISCONNECTED }
      },
      select: { id: true, connectionId: true }
    })
    const rowOf = new Map(connections.map(row => [row.connectionId, row.id]))
    if (ids.some(id => !rowOf.has(id))) {
      this.reject(PluginEventRejectionReasons.UNKNOWN_CONNECTION)
      throw connectionNotFound()
    }

    const foreign = await this.foreignMessageIds(caller, events)
    const queued: ValidRemoteChannelEvent[] = []
    let taken = 0
    for (const event of events) {
      const capability = CAPABILITY_OF[event.type]
      if (capability !== undefined && !this.registry.hasCapability(caller.pluginId, capability)) {
        this.reject(PluginEventRejectionReasons.CAPABILITY_MISSING)
        continue
      }
      if (
        STATUS_EVENTS.includes(event.type) &&
        event.messageId !== undefined &&
        foreign.has(event.messageId)
      ) {
        this.reject(PluginEventRejectionReasons.FOREIGN_MESSAGE)
        continue
      }
      taken += 1
      if (event.type === ChannelEventTypes.CUSTOMER_TYPING) {
        // Not queued and nothing stored: the agents who have the conversation open are told, at most once every 2 seconds
        await this.passTyping(caller, rowOf.get(event.connectionId), event)
        continue
      }
      queued.push(event)
    }
    if (queued.length > 0) await this.queue.enqueue(caller.pluginId, queued)
    return taken
  }

  // The `messageId`s of status events that are NOT a message of a conversation of a connection of this installation. One query for
  // the request: a message of another store, another installation or another channel, and one that does not exist, look the same
  private async foreignMessageIds(
    caller: PluginCaller,
    events: readonly ValidRemoteChannelEvent[]
  ): Promise<Set<string>> {
    const named = [
      ...new Set(
        events.flatMap(event =>
          STATUS_EVENTS.includes(event.type) && event.messageId !== undefined
            ? [event.messageId]
            : []
        )
      )
    ]
    if (named.length === 0) return new Set()
    const own = await this.prisma.client.message.findMany({
      where: {
        id: { in: named },
        storeId: caller.storeId,
        conversation: {
          channelConnection: {
            pluginId: caller.pluginId,
            storeId: caller.storeId,
            installationId: caller.installationId
          }
        }
      },
      select: { id: true }
    })
    const ownIds = new Set(own.map(row => row.id))
    return new Set(named.filter(id => !ownIds.has(id)))
  }

  private async passTyping(
    caller: PluginCaller,
    connectionRowId: string | undefined,
    event: ValidRemoteChannelEvent
  ): Promise<void> {
    if (connectionRowId === undefined) return
    const conversation = await this.prisma.client.conversation.findFirst({
      where: {
        storeId: caller.storeId,
        channelConnectionId: connectionRowId,
        status: { notIn: [...ConversationHiddenStatuses] },
        customerIdentity: { channelType: caller.pluginId, channelIdentity: event.channelIdentity }
      },
      orderBy: [{ lastMessageAt: { sort: 'desc', nulls: 'last' } }, { id: 'desc' }],
      select: { id: true }
    })
    // A customer with no conversation yet has nobody to tell
    if (conversation === null) return
    if (!(await this.limits.takeTyping(conversation.id))) return
    await this.emitter.emitAsync(Events.CUSTOMER_TYPING, {
      storeId: caller.storeId,
      conversationId: conversation.id
    })
  }

  private reject(reason: PluginEventRejectionReason): void {
    this.rejected.inc({ reason })
    this.logger.warn({ reason }, 'an event of a remote channel plugin was dropped')
  }
}
