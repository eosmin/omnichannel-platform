import {
  ChannelConnectionStatus,
  MessageType,
  PluginEventRejectionReasons
} from '@platform/core/domain'
import { ErrorCodes } from '@platform/core/errors'
import { Events } from '@platform/core/events'
import type { ValidRemoteChannelEvent } from '@platform/plugins/runtime'
import { ChannelCapability, ChannelEventTypes } from '@platform/plugins/sdk'

import { PluginChannelEventsService } from './plugin-channel-events.service'

// `expect.objectContaining` is typed `any`: said once, as what it is
const like = (value: object): object => expect.objectContaining(value) as object

const STORE = '00000000-0000-4000-8000-000000000001'
const INSTALLATION = '00000000-0000-4000-8000-0000000000a1'
const PLUGIN = 'acme-chat'
const ROW = '00000000-0000-4000-8000-0000000000c1'
const MESSAGE = '00000000-0000-4000-8000-0000000000d1'
const FOREIGN_MESSAGE = '00000000-0000-4000-8000-0000000000d2'
const CONVERSATION = '00000000-0000-4000-8000-0000000000e1'
const caller = { installationId: INSTALLATION, pluginId: PLUGIN, storeId: STORE }
const TIME = '2026-11-15T12:00:00.000Z'

const received = (connectionId = 'acct-1', externalId = 'm-1'): ValidRemoteChannelEvent => ({
  type: ChannelEventTypes.MESSAGE_RECEIVED,
  connectionId,
  channelIdentity: 'customer-1',
  message: { externalId, type: MessageType.TEXT, content: 'hi', timestamp: TIME },
  timestamp: TIME
})

const status = (
  type: string,
  messageId?: string,
  connectionId = 'acct-1'
): ValidRemoteChannelEvent =>
  ({
    type,
    connectionId,
    channelIdentity: 'customer-1',
    status: { externalId: 'ext-1' },
    ...(messageId === undefined ? {} : { messageId }),
    timestamp: TIME
  }) as ValidRemoteChannelEvent

const typing = (): ValidRemoteChannelEvent => ({
  type: ChannelEventTypes.CUSTOMER_TYPING,
  connectionId: 'acct-1',
  channelIdentity: 'customer-1',
  timestamp: TIME
})

function build(capabilities: readonly string[] = []): {
  service: PluginChannelEventsService
  prisma: {
    channelConnection: { findMany: jest.Mock }
    message: { findMany: jest.Mock }
    conversation: { findFirst: jest.Mock }
  }
  queue: { enqueue: jest.Mock }
  limits: { takeEvents: jest.Mock; takeTyping: jest.Mock }
  emitter: { emitAsync: jest.Mock }
  rejected: { inc: jest.Mock }
} {
  const prisma = {
    channelConnection: {
      findMany: jest.fn().mockResolvedValue([{ id: ROW, connectionId: 'acct-1' }])
    },
    message: { findMany: jest.fn().mockResolvedValue([{ id: MESSAGE }]) },
    conversation: { findFirst: jest.fn().mockResolvedValue({ id: CONVERSATION }) }
  }
  const queue = { enqueue: jest.fn().mockResolvedValue(undefined) }
  const limits = {
    takeEvents: jest.fn().mockResolvedValue(undefined),
    takeTyping: jest.fn().mockResolvedValue(true)
  }
  const emitter = { emitAsync: jest.fn().mockResolvedValue([]) }
  const rejected = { inc: jest.fn() }
  const registry = {
    hasCapability: jest.fn((_id: string, capability: string) => capabilities.includes(capability))
  }
  const logger = { setContext: jest.fn(), warn: jest.fn() }
  const service = new PluginChannelEventsService(
    { client: prisma } as never,
    registry as never,
    queue as never,
    limits as never,
    emitter as never,
    rejected as never,
    logger as never
  )
  return { service, prisma, queue, limits, emitter, rejected }
}

describe('PluginChannelEventsService.ingest', () => {
  it('counts the ceiling first and does nothing else when the plugin is over it', async () => {
    const { service, prisma, queue, limits } = build()
    limits.takeEvents.mockRejectedValue(
      Object.assign(new Error('429'), { code: ErrorCodes.RATE_LIMIT_EXCEEDED })
    )
    await expect(service.ingest(caller, [received(), received('acct-1', 'm-2')])).rejects.toThrow(
      '429'
    )
    expect(limits.takeEvents).toHaveBeenCalledWith(INSTALLATION, 2)
    expect(prisma.channelConnection.findMany).not.toHaveBeenCalled()
    expect(queue.enqueue).not.toHaveBeenCalled()
  })

  it('queues the events under the plugin of the key, after looking the connections up by installation, store and plugin', async () => {
    const { service, prisma, queue } = build()
    const events = [received(), received('acct-1', 'm-2')]
    await expect(service.ingest(caller, events)).resolves.toBe(2)
    expect(prisma.channelConnection.findMany).toHaveBeenCalledWith({
      where: {
        pluginId: PLUGIN,
        storeId: STORE,
        installationId: INSTALLATION,
        connectionId: { in: ['acct-1'] },
        status: { not: ChannelConnectionStatus.DISCONNECTED }
      },
      select: { id: true, connectionId: true }
    })
    expect(queue.enqueue).toHaveBeenCalledWith(PLUGIN, events)
  })

  it('refuses the whole request with 404 when ONE event names a connection that is not the installation’s, and queues nothing', async () => {
    const { service, queue, rejected } = build()
    await expect(
      service.ingest(caller, [received('acct-1'), received('acct-of-another-store')])
    ).rejects.toMatchObject({ code: ErrorCodes.CHANNEL_CONNECTION_NOT_FOUND })
    expect(queue.enqueue).not.toHaveBeenCalled()
    expect(rejected.inc).toHaveBeenCalledWith({
      reason: PluginEventRejectionReasons.UNKNOWN_CONNECTION
    })
  })

  it('drops a status event about a message that is not on a connection of this installation, and counts it', async () => {
    const { service, prisma, queue, rejected } = build()
    const own = status(ChannelEventTypes.MESSAGE_FAILED, MESSAGE)
    const foreign = status(ChannelEventTypes.MESSAGE_FAILED, FOREIGN_MESSAGE)
    await expect(service.ingest(caller, [own, foreign])).resolves.toBe(1)
    expect(queue.enqueue).toHaveBeenCalledWith(PLUGIN, [own])
    expect(rejected.inc).toHaveBeenCalledWith({
      reason: PluginEventRejectionReasons.FOREIGN_MESSAGE
    })
    // One query for the whole request, bound to the store, the plugin and the installation of the key
    expect(prisma.message.findMany).toHaveBeenCalledTimes(1)
    expect(prisma.message.findMany).toHaveBeenCalledWith({
      where: {
        id: { in: [MESSAGE, FOREIGN_MESSAGE] },
        storeId: STORE,
        conversation: {
          channelConnection: { pluginId: PLUGIN, storeId: STORE, installationId: INSTALLATION }
        }
      },
      select: { id: true }
    })
  })

  it.each([ChannelEventTypes.MESSAGE_SENT, ChannelEventTypes.MESSAGE_FAILED])(
    'treats a %s event as about a message of the platform',
    async type => {
      const { service, queue } = build()
      await expect(service.ingest(caller, [status(type, FOREIGN_MESSAGE)])).resolves.toBe(0)
      expect(queue.enqueue).not.toHaveBeenCalled()
    }
  )

  it('does not look messages up when no status event names one', async () => {
    const { service, prisma } = build()
    await service.ingest(caller, [received(), status(ChannelEventTypes.MESSAGE_FAILED)])
    expect(prisma.message.findMany).not.toHaveBeenCalled()
  })

  it('takes a status event that names no message id and leaves it to the connection, which is the installation’s', async () => {
    const { service, queue } = build()
    const event = status(ChannelEventTypes.MESSAGE_FAILED)
    await expect(service.ingest(caller, [event])).resolves.toBe(1)
    expect(queue.enqueue).toHaveBeenCalledWith(PLUGIN, [event])
  })

  it('drops delivered and read events of a channel that declared neither capability, and takes them when it did', async () => {
    const none = build()
    await expect(
      none.service.ingest(caller, [
        status(ChannelEventTypes.MESSAGE_DELIVERED, MESSAGE),
        status(ChannelEventTypes.MESSAGE_READ, MESSAGE)
      ])
    ).resolves.toBe(0)
    expect(none.rejected.inc).toHaveBeenCalledWith({
      reason: PluginEventRejectionReasons.CAPABILITY_MISSING
    })
    expect(none.queue.enqueue).not.toHaveBeenCalled()

    const both = build([ChannelCapability.DELIVERY_RECEIPTS, ChannelCapability.READ_RECEIPTS])
    await expect(
      both.service.ingest(caller, [
        status(ChannelEventTypes.MESSAGE_DELIVERED, MESSAGE),
        status(ChannelEventTypes.MESSAGE_READ, MESSAGE)
      ])
    ).resolves.toBe(2)
  })

  describe('customer typing', () => {
    it('is dropped and counted when the channel did not declare it', async () => {
      const { service, emitter, rejected } = build()
      await expect(service.ingest(caller, [typing()])).resolves.toBe(0)
      expect(emitter.emitAsync).not.toHaveBeenCalled()
      expect(rejected.inc).toHaveBeenCalledWith({
        reason: PluginEventRejectionReasons.CAPABILITY_MISSING
      })
    })

    it('is told to the agents, not queued, and only for a conversation of the connection of the key', async () => {
      const { service, prisma, queue, emitter } = build([ChannelCapability.CUSTOMER_TYPING])
      await expect(service.ingest(caller, [typing()])).resolves.toBe(1)
      expect(queue.enqueue).not.toHaveBeenCalled()
      expect(prisma.conversation.findFirst).toHaveBeenCalledWith(
        like({
          where: like({
            storeId: STORE,
            channelConnectionId: ROW,
            customerIdentity: { channelType: PLUGIN, channelIdentity: 'customer-1' }
          })
        })
      )
      expect(emitter.emitAsync).toHaveBeenCalledWith(Events.CUSTOMER_TYPING, {
        storeId: STORE,
        conversationId: CONVERSATION
      })
    })

    it('is told at most once in the gap', async () => {
      const { service, limits, emitter } = build([ChannelCapability.CUSTOMER_TYPING])
      limits.takeTyping.mockResolvedValue(false)
      await service.ingest(caller, [typing()])
      expect(limits.takeTyping).toHaveBeenCalledWith(CONVERSATION)
      expect(emitter.emitAsync).not.toHaveBeenCalled()
    })

    it('passes one typing per customer and account of the request, not one per event', async () => {
      const { service, prisma } = build([ChannelCapability.CUSTOMER_TYPING])
      await expect(service.ingest(caller, [typing(), typing(), typing()])).resolves.toBe(3)
      expect(prisma.conversation.findFirst).toHaveBeenCalledTimes(1)
    })

    it('never loses the events of the request when passing a typing fails: they are queued first', async () => {
      const { service, prisma, queue, emitter } = build([ChannelCapability.CUSTOMER_TYPING])
      emitter.emitAsync.mockRejectedValue(new Error('a listener failed'))
      const message = received()
      await expect(service.ingest(caller, [typing(), message])).resolves.toBe(2)
      expect(queue.enqueue).toHaveBeenCalledWith(PLUGIN, [message])
      expect(prisma.conversation.findFirst).toHaveBeenCalled()
    })

    it('has nobody to tell when the customer has no conversation yet', async () => {
      const { service, prisma, limits, emitter } = build([ChannelCapability.CUSTOMER_TYPING])
      prisma.conversation.findFirst.mockResolvedValue(null)
      await expect(service.ingest(caller, [typing()])).resolves.toBe(1)
      expect(limits.takeTyping).not.toHaveBeenCalled()
      expect(emitter.emitAsync).not.toHaveBeenCalled()
    })
  })

  it('queues nothing when every event was dropped', async () => {
    const { service, queue } = build()
    await service.ingest(caller, [typing()])
    expect(queue.enqueue).not.toHaveBeenCalled()
  })
})
