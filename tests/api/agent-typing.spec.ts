import { randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'
import { PinoLogger } from 'nestjs-pino'

import { ChannelContextFactory } from '@platform/channels/connections'
import type { CredentialCipher } from '@platform/core/crypto'
import { PrismaService } from '@platform/core/database'
import type { OwnerClient } from '@platform/core/database-testing'
import { OutboundLimits } from '@platform/core/domain'
import { OutboundQueue } from '@platform/core/messaging'
import { JobNames, QueueNames, type SendOutboundTypingJob } from '@platform/core/queues'
import { PluginRegistry } from '@platform/plugins/runtime'
import { ChannelCapability, type ChannelContext, type TypingParams } from '@platform/plugins/sdk'

import { AgentTypingRelay } from '../../apps/api/src/modules/realtime/agent-typing-relay.service'
import { WidgetDelivery } from '../../apps/api/src/modules/widget/widget-delivery.service'
import { TypingSender } from '../../apps/worker/src/outbound/typing-sender.service'
import {
  buildChannelPlugin,
  createChannelConnection,
  createConversation,
  createCustomerIdentity,
  TEST_CHANNEL_ID
} from '../builders'
import { createTestApp } from '../helpers/app'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { queueOf } from '../helpers/queue'

const PLAIN_TEXT_CHANNEL = 'plain_channel'

describe('Showing the customer that an agent is typing', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  let sender: TypingSender
  let shown: TypingParams[] = []
  let sendTypingIndicator: (ctx: ChannelContext, params: TypingParams) => Promise<void>

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp()
    ctx = await seedTestContext(owner, app, prefix)
    const registry = app.get(PluginRegistry, { strict: false })
    registry.register(
      buildChannelPlugin({
        capabilities: [ChannelCapability.TEXT, ChannelCapability.TYPING_INDICATOR],
        sendTypingIndicator: (c, p) => sendTypingIndicator(c, p)
      })
    )
    registry.register(buildChannelPlugin({ id: PLAIN_TEXT_CHANNEL }))
    // The rows of the suite hold bytes that are no ciphertext: the context is what the plugin gets
    const cipher = { open: () => ({}) } as unknown as CredentialCipher // test double of the cipher
    sender = new TypingSender(
      app.get(PrismaService, { strict: false }),
      registry,
      new ChannelContextFactory(cipher),
      await app.resolve(PinoLogger)
    )
  })
  afterAll(async () => {
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })
  beforeEach(() => {
    shown = []
    queueOf(app, QueueNames.OUTBOUND).jobs.length = 0
    sendTypingIndicator = (_ctx, params) => {
      shown.push(params)
      return Promise.resolve()
    }
  })

  const conversationOf = async (pluginId = TEST_CHANNEL_ID, storeId = ctx.storeA.id) => {
    const identity = await createCustomerIdentity(owner, { storeId, channelType: pluginId })
    const connection = await createChannelConnection(owner, { storeId, channelType: pluginId })
    const conversation = await createConversation(owner, {
      storeId,
      customerId: identity.customerId,
      customerIdentityId: identity.id,
      channelType: pluginId,
      channelConnectionId: connection.id
    })
    return { storeId, conversationId: conversation.id }
  }
  const queued = (): SendOutboundTypingJob[] =>
    queueOf(app, QueueNames.OUTBOUND)
      .jobs.filter(item => item.name === JobNames.SEND_OUTBOUND_TYPING)
      .map(item => item.data as SendOutboundTypingJob)

  describe('the api', () => {
    const relayOf = () => app.get(AgentTypingRelay, { strict: false })
    // For the tests that move the clock: the stamp of a job only grows, so one that went to the future
    // would hold back the next test
    const freshRelay = () =>
      new AgentTypingRelay(
        app.get(PrismaService, { strict: false }),
        app.get(PluginRegistry, { strict: false }),
        app.get(OutboundQueue, { strict: false }),
        app.get(WidgetDelivery, { strict: false })
      )

    it('queues a start for a channel that shows typing, once for the repeats of the agent', async () => {
      const { storeId, conversationId } = await conversationOf()
      const relay = relayOf()

      await relay.relay(storeId, conversationId, true)
      await relay.relay(storeId, conversationId, true)
      await relay.relay(storeId, conversationId, true)

      expect(queued()).toEqual([
        { storeId, conversationId, active: true, at: expect.any(Number) as number }
      ])
    })

    it('queues a stop only after a start that went, and once only', async () => {
      const { storeId, conversationId } = await conversationOf()
      const relay = relayOf()

      await relay.relay(storeId, conversationId, false)
      await relay.relay(storeId, conversationId, true)
      await relay.relay(storeId, conversationId, false)
      await relay.relay(storeId, conversationId, false)

      expect(queued().map(job => job.active)).toEqual([true, false])
    })

    it('asks before a start reaches the customer, and a refusal does not use up the slot', async () => {
      const { storeId, conversationId } = await conversationOf()
      const relay = relayOf()

      await relay.relay(storeId, conversationId, true, () => Promise.resolve(false))
      expect(queued()).toEqual([])

      await relay.relay(storeId, conversationId, true, () => Promise.resolve(true))
      expect(queued()).toHaveLength(1)
    })

    it('still sends the stop of an agent when other conversations went on typing for longer than a slot', async () => {
      const first = await conversationOf()
      const second = await conversationOf()
      const relay = freshRelay()
      const now = Date.now()
      const clock = jest.spyOn(Date, 'now')

      try {
        clock.mockReturnValue(now)
        await relay.relay(first.storeId, first.conversationId, true)
        clock.mockReturnValue(now + OutboundLimits.TYPING_ON_SLOT_MS + 1_000)
        await relay.relay(second.storeId, second.conversationId, true)
        clock.mockReturnValue(now + OutboundLimits.TYPING_ON_SLOT_MS + 2_000)
        await relay.relay(first.storeId, first.conversationId, false)
      } finally {
        clock.mockRestore()
      }

      expect(queued().map(job => [job.conversationId, job.active])).toEqual([
        [first.conversationId, true],
        [second.conversationId, true],
        [first.conversationId, false]
      ])
    })

    it('waits a short gap before a start that follows a stop, so alternating the two cannot flicker', async () => {
      const { storeId, conversationId } = await conversationOf()
      const relay = freshRelay()
      const now = Date.now()
      const clock = jest.spyOn(Date, 'now')

      try {
        clock.mockReturnValue(now)
        await relay.relay(storeId, conversationId, true)
        await relay.relay(storeId, conversationId, false)
        await relay.relay(storeId, conversationId, true)
        clock.mockReturnValue(now + OutboundLimits.TYPING_MIN_GAP_MS)
        await relay.relay(storeId, conversationId, true)
      } finally {
        clock.mockRestore()
      }

      expect(queued().map(job => job.active)).toEqual([true, false, true])
    })

    it("does not ask the agent's rights, nor the database twice, for a channel that shows nothing", async () => {
      const { storeId, conversationId } = await conversationOf(PLAIN_TEXT_CHANNEL)
      const mayStart = jest.fn().mockResolvedValue(true)
      const relay = relayOf()

      await relay.relay(storeId, conversationId, true, mayStart)
      await relay.relay(storeId, conversationId, true, mayStart)

      expect(mayStart).not.toHaveBeenCalled()
      expect(queued()).toEqual([])
    })

    it('keeps a start and the stop fired together in order', async () => {
      const { storeId, conversationId } = await conversationOf()
      const relay = relayOf()

      await Promise.all([
        relay.relay(storeId, conversationId, true),
        relay.relay(storeId, conversationId, false)
      ])

      expect(queued().map(job => job.active)).toEqual([true, false])
    })

    it('starts again once the slot of the last start is over', async () => {
      const { storeId, conversationId } = await conversationOf()
      const relay = freshRelay()
      const now = Date.now()
      const clock = jest.spyOn(Date, 'now')

      try {
        clock.mockReturnValue(now)
        await relay.relay(storeId, conversationId, true)
        clock.mockReturnValue(now + OutboundLimits.TYPING_ON_SLOT_MS - 1)
        await relay.relay(storeId, conversationId, true)
        clock.mockReturnValue(now + OutboundLimits.TYPING_ON_SLOT_MS)
        await relay.relay(storeId, conversationId, true)
      } finally {
        clock.mockRestore()
      }

      expect(queued().map(job => job.at)).toEqual([now, now + OutboundLimits.TYPING_ON_SLOT_MS])
    })

    it('stamps each job later than the one before, even inside one millisecond', async () => {
      const { storeId, conversationId } = await conversationOf()
      const relay = freshRelay()
      const clock = jest.spyOn(Date, 'now').mockReturnValue(5_000)

      try {
        await relay.relay(storeId, conversationId, true)
        await relay.relay(storeId, conversationId, false)
        clock.mockReturnValue(6_000)
        await relay.relay(storeId, conversationId, true)
      } finally {
        clock.mockRestore()
      }

      const stamps = queued().map(job => job.at)
      expect(stamps).toEqual([...stamps].sort((a, b) => a - b))
      expect(new Set(stamps).size).toBe(3)
    })

    it('leaves no slot behind for a start that could not be queued', async () => {
      const { storeId, conversationId } = await conversationOf()
      const relay = relayOf()
      const outbound = jest
        .spyOn(app.get(OutboundQueue, { strict: false }), 'enqueueTyping')
        .mockRejectedValueOnce(new Error('redis down'))

      try {
        await expect(relay.relay(storeId, conversationId, true)).rejects.toThrow('redis down')
      } finally {
        outbound.mockRestore()
      }
      await relay.relay(storeId, conversationId, true)

      expect(queued()).toHaveLength(1)
    })

    it('does not mix two conversations', async () => {
      const first = await conversationOf()
      const second = await conversationOf()

      await relayOf().relay(first.storeId, first.conversationId, true)
      await relayOf().relay(second.storeId, second.conversationId, true)

      expect(queued().map(job => job.conversationId)).toEqual([
        first.conversationId,
        second.conversationId
      ])
    })

    it('queues nothing for a channel that does not declare TYPING_INDICATOR', async () => {
      const { storeId, conversationId } = await conversationOf(PLAIN_TEXT_CHANNEL)

      await relayOf().relay(storeId, conversationId, true)

      expect(queued()).toEqual([])
    })

    it('queues nothing for a connection that is not active', async () => {
      const { storeId, conversationId } = await conversationOf()
      await owner.channelConnection.updateMany({
        where: { conversations: { some: { id: conversationId } } },
        data: { status: 'disconnected' }
      })

      await relayOf().relay(storeId, conversationId, true)

      expect(queued()).toEqual([])
    })

    it('queues nothing for a conversation of another store, and does not use up the slot of its own store', async () => {
      const { storeId, conversationId } = await conversationOf(TEST_CHANNEL_ID, ctx.storeB.id)

      await relayOf().relay(ctx.storeA.id, conversationId, true)
      await relayOf().relay(ctx.storeA.id, randomUUID(), true)
      expect(queued()).toEqual([])

      await relayOf().relay(storeId, conversationId, true)
      expect(queued()).toHaveLength(1)
    })
  })

  describe('the worker', () => {
    const jobOf = (
      conversation: { storeId: string; conversationId: string },
      active: boolean,
      at = Date.now()
    ): SendOutboundTypingJob => ({ ...conversation, active, at })

    it('asks the plugin to show and to take away the indicator for the customer it is about', async () => {
      const conversation = await conversationOf()
      const identity = await owner.conversation.findUniqueOrThrow({
        where: { id: conversation.conversationId },
        select: { customerIdentity: { select: { channelIdentity: true } } }
      })
      const connection = await owner.conversation.findUniqueOrThrow({
        where: { id: conversation.conversationId },
        select: { channelConnection: { select: { connectionId: true } } }
      })
      const contexts: ChannelContext[] = []
      sendTypingIndicator = (c, params) => {
        contexts.push(c)
        shown.push(params)
        return Promise.resolve()
      }
      const at = Date.now()

      await sender.send(jobOf(conversation, true, at))
      await sender.send(jobOf(conversation, false, at + 1))

      const channelIdentity = identity.customerIdentity.channelIdentity
      expect(shown).toEqual([
        { channelIdentity, active: true },
        { channelIdentity, active: false }
      ])
      expect(contexts.map(c => [c.storeId, c.connectionId])).toEqual([
        [conversation.storeId, connection.channelConnection.connectionId],
        [conversation.storeId, connection.channelConnection.connectionId]
      ])
    })

    it('does nothing for a plugin that does not declare TYPING_INDICATOR', async () => {
      const conversation = await conversationOf(PLAIN_TEXT_CHANNEL)

      await sender.send(jobOf(conversation, true))

      expect(shown).toEqual([])
    })

    it('does nothing for a disconnected connection', async () => {
      const mine = await conversationOf()
      await owner.channelConnection.updateMany({
        where: { conversations: { some: { id: mine.conversationId } } },
        data: { status: 'disconnected' }
      })

      await sender.send(jobOf(mine, true))

      expect(shown).toEqual([])
    })

    it('does nothing for a conversation of another store, and shows one of its own', async () => {
      const mine = await conversationOf()
      const theirs = await conversationOf(TEST_CHANNEL_ID, ctx.storeB.id)

      await sender.send(
        jobOf({ storeId: ctx.storeA.id, conversationId: theirs.conversationId }, true)
      )
      expect(shown).toEqual([])

      await sender.send(jobOf(mine, true))
      expect(shown).toHaveLength(1)
    })

    it('drops a job that waited too long in the queue', async () => {
      const conversation = await conversationOf()

      await sender.send(jobOf(conversation, true, Date.now() - OutboundLimits.TYPING_STALE_MS - 1))

      expect(shown).toEqual([])
    })

    it('still takes the indicator away when the stop waited too long: it is still on', async () => {
      const conversation = await conversationOf()

      await sender.send(jobOf(conversation, false, Date.now() - OutboundLimits.TYPING_STALE_MS - 1))

      expect(shown.map(params => params.active)).toEqual([false])
    })

    it('drops a job stamped in the future, which would hold the conversation ahead of every real one', async () => {
      const conversation = await conversationOf()

      await sender.send(
        jobOf(conversation, true, Date.now() + OutboundLimits.TYPING_STALE_MS + 60_000)
      )
      await sender.send(jobOf(conversation, true))

      expect(shown).toHaveLength(1)
    })

    // The relay stamps each job later than the one before (see the api tests), so a tie can only be one
    // job seen twice: dropping it keeps the newer state
    it('takes a job with the time of the one before as the same job', async () => {
      const conversation = await conversationOf()
      const at = Date.now()

      await sender.send(jobOf(conversation, true, at))
      await sender.send(jobOf(conversation, false, at))

      expect(shown.map(params => params.active)).toEqual([true])
    })

    it('lets go of a failure of the database too, so the job is not dead-lettered', async () => {
      const conversation = await conversationOf()

      const lookup = jest
        .spyOn(app.get(PrismaService, { strict: false }).client.conversation, 'findFirst')
        .mockRejectedValueOnce(new Error('db down'))

      try {
        await expect(sender.send(jobOf(conversation, true))).resolves.toBeUndefined()
        expect(lookup).toHaveBeenCalledTimes(1)
      } finally {
        lookup.mockRestore()
      }
    })

    it('drops a job that a newer one of the conversation overtook', async () => {
      const conversation = await conversationOf()
      const at = Date.now()

      await sender.send(jobOf(conversation, false, at))
      await sender.send(jobOf(conversation, true, at - 1))

      expect(shown.map(params => params.active)).toEqual([false])
    })

    it('lets go of a failure: tries the plugin once and never rethrows', async () => {
      const conversation = await conversationOf()
      const attempts = jest.fn()
      sendTypingIndicator = () => {
        attempts()
        return Promise.reject(new Error('socket hang up'))
      }

      await expect(sender.send(jobOf(conversation, true))).resolves.toBeUndefined()

      expect(attempts).toHaveBeenCalledTimes(1)
    })
  })
})
