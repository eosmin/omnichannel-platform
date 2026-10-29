import { getQueueToken } from '@nestjs/bullmq'
import type { INestApplication } from '@nestjs/common'
import { PinoLogger } from 'nestjs-pino'

import { ChannelContextFactory } from '@platform/channels/connections'
import type { CredentialCipher } from '@platform/core/crypto'
import { PrismaService } from '@platform/core/database'
import type { OwnerClient } from '@platform/core/database-testing'
import { DAY_MS, HOUR_MS } from '@platform/core/domain'
import { ErrorCodes } from '@platform/core/errors'
import {
  ChannelConnectionResolver,
  CustomerProfileService,
  needsProfileRead,
  type ProfileRead
} from '@platform/core/messaging'
import { JobNames, QueueNames } from '@platform/core/queues'
import { PluginRegistry } from '@platform/plugins/runtime'
import {
  ChannelCapability,
  type ChannelContext,
  type ChannelCustomerProfile,
  PluginError
} from '@platform/plugins/sdk'

import { ProfileFetcher } from '../../apps/worker/src/inbound/profile-fetcher.service'
import { ProfileRequester } from '../../apps/worker/src/inbound/profile-requester.service'
import {
  buildChannelPlugin,
  createChannelConnection,
  createCustomerIdentity,
  TEST_CHANNEL_ID
} from '../builders'
import { createTestApp } from '../helpers/app'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { CapturedQueue, queueOf } from '../helpers/queue'

const PLAIN_CHANNEL = 'plain_channel'

describe('The name and photo of a customer', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  let fetcher: ProfileFetcher
  let requester: ProfileRequester
  let calls: { ctx: ChannelContext; channelIdentity: string }[] = []
  let answer: () => Promise<ChannelCustomerProfile | null>

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp([], builder =>
      builder
        .overrideProvider(getQueueToken(QueueNames.CUSTOMER_PROFILES))
        .useValue(new CapturedQueue())
    )
    ctx = await seedTestContext(owner, app, prefix)
    const prisma = app.get(PrismaService, { strict: false })
    const registry = app.get(PluginRegistry, { strict: false })
    registry.register(
      buildChannelPlugin({
        capabilities: [ChannelCapability.TEXT, ChannelCapability.CUSTOMER_PROFILE],
        fetchProfile: (c, channelIdentity) => {
          calls.push({ ctx: c, channelIdentity })
          return answer()
        }
      })
    )
    registry.register(buildChannelPlugin({ id: PLAIN_CHANNEL }))
    // The rows of the suite hold bytes that are no ciphertext: the context is what the plugin gets
    const cipher = { open: () => ({}) } as unknown as CredentialCipher // test double of the cipher
    fetcher = new ProfileFetcher(
      prisma,
      registry,
      new ChannelContextFactory(cipher),
      new CustomerProfileService(prisma),
      await app.resolve(PinoLogger)
    )
    requester = new ProfileRequester(
      prisma,
      registry,
      new ChannelConnectionResolver(prisma),
      queueOf(app, QueueNames.CUSTOMER_PROFILES) as never,
      await app.resolve(PinoLogger)
    )
  })
  afterAll(async () => {
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })
  beforeEach(() => {
    calls = []
    queueOf(app, QueueNames.CUSTOMER_PROFILES).jobs.length = 0
    answer = () =>
      Promise.resolve({
        name: 'Peter Chang',
        username: 'peter',
        avatarUrl: 'https://cdn.example/p.jpg'
      })
  })

  // A customer with no name yet on one connection of their channel
  const setup = async (
    over: { storeId?: string; channelType?: string; customerName?: string | null } = {}
  ): Promise<{
    storeId: string
    identityId: string
    customerId: string
    connectionRowId: string
    connectionId: string
    handle: string
  }> => {
    const storeId = over.storeId ?? ctx.storeA.id
    const channelType = over.channelType ?? TEST_CHANNEL_ID
    const identity = await createCustomerIdentity(owner, { storeId, channelType })
    const connection = await createChannelConnection(owner, { storeId, channelType })
    const row = await owner.customerIdentity.findUniqueOrThrow({
      where: { id: identity.id },
      select: { channelIdentity: true }
    })
    const channel = await owner.channelConnection.findUniqueOrThrow({
      where: { id: connection.id },
      select: { connectionId: true }
    })
    if (over.customerName !== undefined) {
      await owner.customer.update({
        where: { id: identity.customerId },
        data: { name: over.customerName }
      })
    }
    return {
      storeId,
      identityId: identity.id,
      customerId: identity.customerId,
      connectionRowId: connection.id,
      connectionId: channel.connectionId,
      handle: row.channelIdentity
    }
  }
  const identityRow = (
    id: string
  ): Promise<{
    displayName: string | null
    username: string | null
    avatarUrl: string | null
    profileFetchedAt: Date | null
    profileRetryAfter: Date | null
    profileFetchError: string | null
  }> =>
    owner.customerIdentity.findUniqueOrThrow({
      where: { id },
      select: {
        displayName: true,
        username: true,
        avatarUrl: true,
        profileFetchedAt: true,
        profileRetryAfter: true,
        profileFetchError: true
      }
    })

  describe('reading it', () => {
    it('stores what the channel answers, asking with the id of the person', async () => {
      const t = await setup({ customerName: null })

      await fetcher.fetch(t, false)

      expect(calls).toHaveLength(1)
      expect(calls[0]?.channelIdentity).toBe(t.handle)
      const row = await identityRow(t.identityId)
      expect(row).toMatchObject({
        displayName: 'Peter Chang',
        username: 'peter',
        avatarUrl: 'https://cdn.example/p.jpg',
        profileFetchError: null
      })
      expect(row.profileFetchedAt).not.toBeNull()
    })

    it('names a customer who has no name, and leaves the name an agent gave', async () => {
      const unnamed = await setup({ customerName: null })
      const named = await setup({ customerName: 'Pedro the agent wrote' })

      await fetcher.fetch(unnamed, false)
      await fetcher.fetch(named, false)

      const customers = await owner.customer.findMany({
        where: { id: { in: [unnamed.customerId, named.customerId] } },
        select: { id: true, name: true }
      })
      const nameOf = (id: string): string | null => customers.find(c => c.id === id)?.name ?? null
      expect(nameOf(unnamed.customerId)).toBe('Peter Chang')
      expect(nameOf(named.customerId)).toBe('Pedro the agent wrote')
    })

    it('stamps a person with no profile so that it is not asked again', async () => {
      const t = await setup()
      answer = () => Promise.resolve(null)

      await fetcher.fetch(t, false)

      const row = await identityRow(t.identityId)
      expect(row).toMatchObject({
        displayName: null,
        username: null,
        avatarUrl: null,
        profileFetchError: null
      })
      expect(row.profileFetchedAt).not.toBeNull()
    })

    it('keeps what was stored when a later read finds nothing', async () => {
      const t = await setup()
      await fetcher.fetch(t, false)
      answer = () => Promise.resolve(null)

      await fetcher.fetch(t, false)

      expect(await identityRow(t.identityId)).toMatchObject({
        displayName: 'Peter Chang',
        username: 'peter',
        avatarUrl: 'https://cdn.example/p.jpg'
      })
    })

    it('drops a stored photo link that a later read with data no longer gives', async () => {
      const t = await setup()
      await fetcher.fetch(t, false)
      answer = () => Promise.resolve({ username: 'peter' })
      await fetcher.fetch(t, false)
      expect(await identityRow(t.identityId)).toMatchObject({ username: 'peter', avatarUrl: null })
    })

    it('keeps the name when a later read gives a username and a photo but no name', async () => {
      const t = await setup()
      await fetcher.fetch(t, false)
      answer = () => Promise.resolve({ username: 'peter2', avatarUrl: 'https://cdn.example/n.jpg' })
      await fetcher.fetch(t, false)
      expect(await identityRow(t.identityId)).toMatchObject({
        displayName: 'Peter Chang',
        username: 'peter2',
        avatarUrl: 'https://cdn.example/n.jpg'
      })
    })

    it('keeps the valid fields when one comes with the wrong type', async () => {
      const t = await setup()
      answer = () =>
        Promise.resolve({ name: 'Ana', avatarUrl: 123 } as unknown as ChannelCustomerProfile)
      await fetcher.fetch(t, false)
      expect(await identityRow(t.identityId)).toMatchObject({ displayName: 'Ana', avatarUrl: null })
    })

    it('drops the photo link, which has expired, when the channel then refuses', async () => {
      const t = await setup()
      await fetcher.fetch(t, false)
      answer = () =>
        Promise.reject(new PluginError(ErrorCodes.CHANNEL_MESSAGE_FAILED, { retryable: false }))
      await fetcher.fetch(t, false)
      expect(await identityRow(t.identityId)).toMatchObject({
        displayName: 'Peter Chang',
        avatarUrl: null,
        profileFetchError: ErrorCodes.CHANNEL_MESSAGE_FAILED
      })
    })

    it('drops a photo link that is not plain https', async () => {
      const t = await setup()
      answer = () => Promise.resolve({ username: 'peter', avatarUrl: 'http://cdn.example/p.jpg' })
      await fetcher.fetch(t, false)
      expect((await identityRow(t.identityId)).avatarUrl).toBeNull()
    })

    it('tries again while attempts remain, and records the code, without a stamp, on the last', async () => {
      const t = await setup()
      answer = () =>
        Promise.reject(new PluginError(ErrorCodes.CHANNEL_MESSAGE_FAILED, { retryable: true }))

      await expect(fetcher.fetch(t, false)).rejects.toThrow('reading a profile failed')
      expect((await identityRow(t.identityId)).profileFetchedAt).toBeNull()

      await fetcher.fetch(t, true)
      const row = await identityRow(t.identityId)
      expect(row.profileFetchError).toBe(ErrorCodes.CHANNEL_MESSAGE_FAILED)
      // An outage is no answer: the date of the last real read stays empty, and the next message waits
      // a short while before it asks again
      expect(row.profileFetchedAt).toBeNull()
      expect(row.profileRetryAfter).not.toBeNull()
      expect(needsProfileRead(row, new Date())).toBe(false)
      expect(needsProfileRead(row, new Date(Date.now() + 2 * HOUR_MS))).toBe(true)
    })

    it('keeps the name when the plugin sends null for a field it has not got', async () => {
      const t = await setup()
      answer = () =>
        Promise.resolve({ name: 'Ana', avatarUrl: null } as unknown as ChannelCustomerProfile)
      await fetcher.fetch(t, false)
      expect(await identityRow(t.identityId)).toMatchObject({ displayName: 'Ana', avatarUrl: null })
    })

    it('does not call a plugin that is late to register unsupported for good', async () => {
      const t = await setup({ channelType: 'late_channel' })
      await fetcher.fetch(t, true)
      const row = await identityRow(t.identityId)
      expect(row.profileFetchError).toBe(ErrorCodes.CHANNEL_NOT_CONNECTED)
      expect(row.profileFetchedAt).toBeNull()
      expect(needsProfileRead(row, new Date(Date.now() + 2 * HOUR_MS))).toBe(true)
    })

    it('records a refusal for good at once, without another attempt', async () => {
      const t = await setup()
      answer = () =>
        Promise.reject(new PluginError(ErrorCodes.CHANNEL_MESSAGE_FAILED, { retryable: false }))
      await fetcher.fetch(t, false)
      expect((await identityRow(t.identityId)).profileFetchError).toBe(
        ErrorCodes.CHANNEL_MESSAGE_FAILED
      )
    })

    it('does not hold a person to the refusal of a token: credentials are asked again after a wait', async () => {
      const t = await setup()
      answer = () =>
        Promise.reject(
          new PluginError(ErrorCodes.CHANNEL_CREDENTIALS_INVALID, { retryable: false })
        )

      await fetcher.fetch(t, false)

      const row = await identityRow(t.identityId)
      expect(row.profileFetchError).toBe(ErrorCodes.CHANNEL_CREDENTIALS_INVALID)
      expect(row.profileFetchedAt).toBeNull()
      expect(needsProfileRead(row, new Date(Date.now() + 2 * HOUR_MS))).toBe(true)
    })

    it('does nothing for a connection or a person that is gone', async () => {
      const t = await setup()
      await fetcher.fetch({ ...t, connectionRowId: '00000000-0000-4000-8000-000000000000' }, true)
      await fetcher.fetch({ ...t, identityId: '00000000-0000-4000-8000-000000000000' }, true)
      expect(calls).toHaveLength(0)
      expect((await identityRow(t.identityId)).profileFetchedAt).toBeNull()
    })

    it('never reads or writes across stores: the job names the store of both rows', async () => {
      const t = await setup()
      const other = await setup({ storeId: ctx.storeB.id })

      await fetcher.fetch({ ...t, storeId: ctx.storeB.id }, true)
      await fetcher.fetch({ ...other, identityId: t.identityId }, true)

      expect(calls).toHaveLength(0)
      expect((await identityRow(t.identityId)).profileFetchedAt).toBeNull()
    })
  })

  describe('asking for it after a message', () => {
    const jobs = (): { name: string; data: unknown; opts?: { jobId?: string } }[] =>
      queueOf(app, QueueNames.CUSTOMER_PROFILES).jobs

    it('queues one job for a profile never read', async () => {
      const t = await setup()

      await requester.request(TEST_CHANNEL_ID, t.connectionId, t.handle)
      await requester.request(TEST_CHANNEL_ID, t.connectionId, t.handle)

      expect(jobs().map(job => job.name)).toEqual([
        JobNames.FETCH_CUSTOMER_PROFILE,
        JobNames.FETCH_CUSTOMER_PROFILE
      ])
      expect(jobs()[0]).toMatchObject({
        data: {
          storeId: t.storeId,
          identityId: t.identityId,
          connectionRowId: t.connectionRowId
        }
      })
      // The same state is the same job: the queue keeps one
      expect(jobs()[0]?.opts?.jobId).toBe(jobs()[1]?.opts?.jobId)
    })

    it('leaves a recent profile alone and asks again once it is stale', async () => {
      const t = await setup()
      await owner.customerIdentity.update({
        where: { id: t.identityId },
        data: { profileFetchedAt: new Date(Date.now() - DAY_MS) }
      })
      await requester.request(TEST_CHANNEL_ID, t.connectionId, t.handle)
      expect(jobs()).toHaveLength(0)

      await owner.customerIdentity.update({
        where: { id: t.identityId },
        data: { profileFetchedAt: new Date(Date.now() - 8 * DAY_MS) }
      })
      await requester.request(TEST_CHANNEL_ID, t.connectionId, t.handle)
      expect(jobs()).toHaveLength(1)
    })

    it('does not ask a channel that cannot answer, or about a connection it does not know', async () => {
      const plain = await setup({ channelType: PLAIN_CHANNEL })
      await requester.request(PLAIN_CHANNEL, plain.connectionId, plain.handle)

      const t = await setup()
      await requester.request(TEST_CHANNEL_ID, 'no-such-connection', t.handle)
      await requester.request(TEST_CHANNEL_ID, t.connectionId, 'nobody')

      expect(jobs()).toHaveLength(0)
    })

    it('does not fail the message when the queue is down', async () => {
      const t = await setup()
      const queue = queueOf(app, QueueNames.CUSTOMER_PROFILES)
      const add = queue.add.bind(queue)
      queue.add = () => Promise.reject(new Error('redis is down'))
      try {
        await expect(
          requester.request(TEST_CHANNEL_ID, t.connectionId, t.handle)
        ).resolves.toBeUndefined()
      } finally {
        queue.add = add
      }
    })
  })
})

// Keeps the type of what a plugin hands over in step with what the core stores
const _sameShape: ProfileRead = {} satisfies ChannelCustomerProfile
void _sameShape
