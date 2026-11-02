import { randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import type { OwnerClient } from '@platform/core/database-testing'
import { AuthorType, MediaRefetchLimits, MessageType } from '@platform/core/domain'
import { type FetchInboundMediaJob, JobNames, QueueNames } from '@platform/core/queues'

import {
  createChannelConnection,
  createConversation,
  createCustomerIdentity,
  TEST_CHANNEL_ID
} from '../builders'
import { createTestApp } from '../helpers/app'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { api } from '../helpers/http'
import { queueOf } from '../helpers/queue'

const OK = 200
const FORBIDDEN = 403
const NOT_FOUND = 404
const CONFLICT = 409
const BAD_REQUEST = 400

const SOURCE = {
  pluginId: TEST_CHANNEL_ID,
  connectionId: 'provider-connection',
  ref: 'wa-media-id',
  contentType: 'image/jpeg',
  filename: 'photo.jpg'
}

describe('Downloading a lost file of the customer again', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp()
    ctx = await seedTestContext(owner, app, prefix)
  })
  afterAll(async () => {
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })
  beforeEach(() => {
    queueOf(app, QueueNames.HEAVY_PROCESSING).jobs.length = 0
  })

  const conversationOn = async (storeId: string): Promise<string> => {
    const identity = await createCustomerIdentity(owner, { storeId, channelType: TEST_CHANNEL_ID })
    const connection = await createChannelConnection(owner, {
      storeId,
      channelType: TEST_CHANNEL_ID
    })
    const conversation = await createConversation(owner, {
      storeId,
      customerId: identity.customerId,
      customerIdentityId: identity.id,
      channelType: TEST_CHANNEL_ID,
      channelConnectionId: connection.id
    })
    return conversation.id
  }
  const lostFile = async (
    over: {
      storeId?: string
      authorType?: string
      deletedAt?: Date
      entry?: Record<string, unknown>
      metadata?: Record<string, unknown>
    } = {}
  ): Promise<string> => {
    const storeId = over.storeId ?? ctx.storeA.id
    const created = await owner.message.create({
      data: {
        storeId,
        conversationId: await conversationOn(storeId),
        type: MessageType.IMAGE,
        content: null,
        authorType: over.authorType ?? AuthorType.CUSTOMER,
        channelMessageId: `in-${randomUUID()}`,
        metadata: {
          attachmentUrl: 'https://example.com/kept',
          unavailableFiles: [{ index: 0, code: 'fetch_failed', source: SOURCE, ...over.entry }],
          ...over.metadata
        },
        ...(over.deletedAt === undefined ? {} : { deletedAt: over.deletedAt })
      },
      select: { id: true }
    })
    return created.id
  }
  const metadataOf = async (id: string): Promise<Record<string, unknown>> =>
    (await owner.message.findUniqueOrThrow({ where: { id }, select: { metadata: true } }))
      .metadata as Record<string, unknown>
  const refetch = (id: string, index: number | string = 0, who = ctx.agentA) =>
    api(app, who, ctx.storeA).post(ApiRoutes.messages.refetchFile(id, index))
  const jobs = () =>
    queueOf(app, QueueNames.HEAVY_PROCESSING).jobs.filter(
      job => job.name === JobNames.FETCH_INBOUND_MEDIA
    )

  it('queues the fetch from what the worker kept, and from nothing the caller sent', async () => {
    const id = await lostFile()

    const response = await refetch(id)

    expect(response.status).toBe(OK)
    expect(response.body).toMatchObject({
      id,
      unavailableFiles: [{ index: 0, code: 'fetch_failed', canRetry: true }]
    })
    expect(jobs()).toHaveLength(1)
    expect(jobs()[0]?.data).toEqual({
      messageId: id,
      index: 0,
      storeId: ctx.storeA.id,
      pluginId: SOURCE.pluginId,
      connectionId: SOURCE.connectionId,
      mediaRef: SOURCE.ref,
      contentType: SOURCE.contentType,
      filename: SOURCE.filename
    } satisfies FetchInboundMediaJob)
    expect(jobs()[0]?.opts?.jobId).toMatch(new RegExp(`^refetch-media-${id}-0-\\d+$`))
  })

  it('writes the time of the request and keeps the rest of the metadata', async () => {
    const id = await lostFile()

    await refetch(id)

    const stored = await metadataOf(id)
    expect(stored.attachmentUrl).toBe('https://example.com/kept')
    expect(stored.unavailableFiles).toEqual([
      expect.objectContaining({
        index: 0,
        code: 'fetch_failed',
        source: SOURCE,
        requestedAt: expect.any(String) as string
      })
    ])
  })

  it('refuses a second request while the first one is still working', async () => {
    const id = await lostFile()
    await refetch(id)

    const again = await refetch(id)

    expect(again.status).toBe(CONFLICT)
    expect(jobs()).toHaveLength(1)
  })

  it('accepts the request again after the wait', async () => {
    const id = await lostFile({
      entry: {
        requestedAt: new Date(Date.now() - MediaRefetchLimits.COOLDOWN_MS - 1000).toISOString()
      }
    })

    const response = await refetch(id)

    expect(response.status).toBe(OK)
    expect(jobs()).toHaveLength(1)
  })

  it.each(['refused', 'unsafe_link', 'channel_cannot_fetch'])(
    'refuses a file lost as %s: asking again would give the same answer',
    async code => {
      const id = await lostFile({ entry: { code } })

      const response = await refetch(id)

      expect(response.status).toBe(CONFLICT)
      expect(jobs()).toHaveLength(0)
    }
  )

  it('takes a time it cannot read for no wait, and replaces it', async () => {
    const id = await lostFile({ entry: { requestedAt: 'not a time' } })

    expect((await refetch(id)).status).toBe(OK)
    expect(jobs()).toHaveLength(1)
  })

  it('never offers a code of a newer worker again', async () => {
    const id = await lostFile({ entry: { code: 'quarantined' } })

    expect((await refetch(id)).status).toBe(CONFLICT)
    expect(jobs()).toHaveLength(0)
  })

  it('fails the request and leaves no wait behind when the queue is down', async () => {
    const id = await lostFile()
    const queue = queueOf(app, QueueNames.HEAVY_PROCESSING)
    const add = jest.spyOn(queue, 'add').mockRejectedValueOnce(new Error('redis down'))

    const response = await refetch(id)
    add.mockRestore()

    expect(response.status).toBeGreaterThanOrEqual(500)
    expect(JSON.stringify(await metadataOf(id))).not.toContain('requestedAt')
    expect((await refetch(id)).status).toBe(OK)
  })

  it('refuses a file whose source was not kept', async () => {
    const id = await lostFile({ entry: { source: undefined } })

    const response = await refetch(id)

    expect(response.status).toBe(CONFLICT)
    expect(jobs()).toHaveLength(0)
  })

  it('never uses a source that is a link', async () => {
    const id = await lostFile({
      entry: { source: { ...SOURCE, ref: 'http://169.254.169.254/latest/meta-data' } }
    })

    const response = await refetch(id)

    expect(response.status).toBe(CONFLICT)
    expect(jobs()).toHaveLength(0)
  })

  it('answers not found for a place that is not listed', async () => {
    const id = await lostFile()

    expect((await refetch(id, 1)).status).toBe(NOT_FOUND)
    expect(jobs()).toHaveLength(0)
  })

  it.each(['-1', 'x', '1.5', '30', '0x1', '1e0', '01', '+1'])(
    'rejects the place %j',
    async index => {
      const id = await lostFile()

      expect((await refetch(id, index)).status).toBe(BAD_REQUEST)
      expect(jobs()).toHaveLength(0)
    }
  )

  it("is refused for a message that is not the customer's", async () => {
    const id = await lostFile({ authorType: AuthorType.AGENT })

    expect((await refetch(id)).status).toBe(CONFLICT)
    expect(jobs()).toHaveLength(0)
  })

  it('is refused for a message that was deleted', async () => {
    const id = await lostFile({ deletedAt: new Date() })

    expect((await refetch(id)).status).toBe(CONFLICT)
    expect(jobs()).toHaveLength(0)
  })

  it('is refused to who may not send, and changes nothing', async () => {
    const id = await lostFile()

    const response = await refetch(id, 0, ctx.viewerA)

    expect(response.status).toBe(FORBIDDEN)
    expect(jobs()).toHaveLength(0)
    expect(JSON.stringify(await metadataOf(id))).not.toContain('requestedAt')
  })

  it('does not reach a message of another store', async () => {
    const id = await lostFile({ storeId: ctx.storeB.id })

    const response = await refetch(id)

    expect(response.status).toBe(NOT_FOUND)
    expect(jobs()).toHaveLength(0)
    expect(JSON.stringify(await metadataOf(id))).not.toContain('requestedAt')
  })
})
