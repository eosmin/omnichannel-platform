import { randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import type { OwnerClient } from '@platform/core/database-testing'
import { AuthorType, MessageType } from '@platform/core/domain'
import { JobNames, QueueNames } from '@platform/core/queues'

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

// Values nothing else in the api would ever write: if one of them shows in an answer, the source of a
// lost file (the connection and the id of the provider's media, kept so that an agent can ask for the
// file again) reached someone who has no use for it.
const CANARY = {
  pluginId: TEST_CHANNEL_ID,
  connectionId: 'canary-connection-6b1f0e',
  ref: 'canary-provider-media-6b1f0e',
  contentType: 'image/jpeg',
  filename: 'canary-name-6b1f0e.jpg'
}
const CANARY_TEXTS = [CANARY.connectionId, CANARY.ref, CANARY.filename]

// The only two answers that carry a customer message with a lost file are the thread and the request
// to ask for the file again; the other readers of the metadata are held to a list by
// `lost-file-source-readers.spec.ts`.
describe('The source of a lost customer file is not in what the api answers', () => {
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

  const asAgent = () => api(app, ctx.agentA, ctx.storeA)

  const lostFile = async (): Promise<{ messageId: string; conversationId: string }> => {
    const identity = await createCustomerIdentity(owner, {
      storeId: ctx.storeA.id,
      channelType: TEST_CHANNEL_ID
    })
    const connection = await createChannelConnection(owner, {
      storeId: ctx.storeA.id,
      channelType: TEST_CHANNEL_ID
    })
    const conversation = await createConversation(owner, {
      storeId: ctx.storeA.id,
      customerId: identity.customerId,
      customerIdentityId: identity.id,
      channelType: TEST_CHANNEL_ID,
      channelConnectionId: connection.id
    })
    const message = await owner.message.create({
      data: {
        storeId: ctx.storeA.id,
        conversationId: conversation.id,
        type: MessageType.IMAGE,
        content: null,
        authorType: AuthorType.CUSTOMER,
        channelMessageId: `in-${randomUUID()}`,
        metadata: {
          unavailableFiles: [{ index: 0, code: 'fetch_failed', source: CANARY }]
        }
      },
      select: { id: true }
    })
    return { messageId: message.id, conversationId: conversation.id }
  }

  // The text of the answer, whole: a value that moved to another name or another depth is found too
  const expectNoSource = (body: unknown): void => {
    const text = JSON.stringify(body)
    for (const canary of CANARY_TEXTS) expect(text).not.toContain(canary)
  }
  const filesOf = (message: { unavailableFiles?: unknown } | undefined): unknown =>
    message?.unavailableFiles

  it('is not in the thread of the conversation, which still says the file can be asked for again', async () => {
    const { messageId, conversationId } = await lostFile()

    const response = await asAgent().get(ApiRoutes.conversations.messages(conversationId))

    expect(response.status).toBe(OK)
    const thread = (response.body as { data: { id: string; unavailableFiles?: unknown }[] }).data
    expect(filesOf(thread.find(item => item.id === messageId))).toEqual([
      { index: 0, code: 'fetch_failed', canRetry: true }
    ])
    expectNoSource(response.body)
  })

  it('is not in the answer of asking for the file again, which did ask for it', async () => {
    const { messageId } = await lostFile()
    queueOf(app, QueueNames.HEAVY_PROCESSING).jobs.length = 0

    const response = await asAgent().post(ApiRoutes.messages.refetchFile(messageId, 0))

    expect(response.status).toBe(OK)
    expect(filesOf(response.body as { unavailableFiles?: unknown })).toEqual([
      { index: 0, code: 'fetch_failed', canRetry: true }
    ])
    expect(
      queueOf(app, QueueNames.HEAVY_PROCESSING).jobs.filter(
        job => job.name === JobNames.FETCH_INBOUND_MEDIA
      )
    ).toHaveLength(1)
    expectNoSource(response.body)
  })
})
