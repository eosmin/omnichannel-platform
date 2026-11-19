import { randomUUID } from 'node:crypto'

import { JobContext, JobContextGoneError, PrismaService } from '@platform/core/database'
import { connectionUrls, ensureStore, type OwnerClient } from '@platform/core/database-testing'
import { AuthorType, DeliveryStatus } from '@platform/core/domain'

import { MessageStatusWriter } from '../../apps/worker/src/outbound/message-status.writer'
import { ReactionStatusWriter } from '../../apps/worker/src/outbound/reaction-status.writer'
import { createMessage, createConversationOf } from '../builders'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'

// Row-Level Security, phase 5, PR C: the services of the worker that write the state of a reply do all of their database work inside a
// JobContext of the store of the job. The worker connects as platform_worker and the guard of PrismaService is ON (requireContext, what
// WORKER_RLS_CONTEXT turns on in the worker): a statement outside a context throws, so a service with one bare access fails here and
// not as an empty answer once the role loses BYPASSRLS. A store that does not exist is a job whose subject is gone, never a silent
// "nothing to do".
describe('the services of the outbound state run inside a job context', () => {
  const prefix = newRunPrefix()
  const owner: OwnerClient = ownerClient()
  const prisma = new PrismaService({ databaseUrl: connectionUrls().worker, requireContext: true })
  const jobContext = new JobContext(prisma)
  const events = { publish: jest.fn() }
  let storeId: string
  let otherStoreId: string
  let messageId: string

  beforeAll(async () => {
    const org = await owner.organization.create({
      data: { name: `${prefix}-org`, slug: `${prefix}-org` }
    })
    storeId = (await ensureStore(owner, org.id, `${prefix}-a`)).id
    otherStoreId = (await ensureStore(owner, org.id, `${prefix}-b`)).id
    const conversation = await createConversationOf(owner, { storeId })
    messageId = (
      await createMessage(owner, {
        storeId,
        conversationId: conversation.id,
        authorType: AuthorType.AGENT
      })
    ).id
    await owner.message.update({
      where: { id: messageId },
      data: { deliveryStatus: DeliveryStatus.QUEUED }
    })
  })

  afterAll(async () => {
    await cleanUp(owner, prefix)
    await prisma.onModuleDestroy()
    await owner.$disconnect()
  })

  it('refuses a bare statement of the worker, which proves the guard is on', async () => {
    await expect(prisma.client.message.findFirst({ where: { id: messageId } })).rejects.toThrow(
      /no tenant context/
    )
  })

  it('settles the delivery state of a reply under the context of its store', async () => {
    const writer = new MessageStatusWriter(prisma, events as never, jobContext)
    await expect(
      writer.apply({ storeId, messageId, to: DeliveryStatus.SENT, channelMessageId: 'ext-1' })
    ).resolves.toBe(true)
    const row = await owner.message.findUniqueOrThrow({ where: { id: messageId } })
    expect(row.deliveryStatus).toBe(DeliveryStatus.SENT)
    expect(row.channelMessageId).toBe('ext-1')
  })

  it('does not touch the message of another store, which a context of the wrong store does not see', async () => {
    const writer = new MessageStatusWriter(prisma, events as never, jobContext)
    await owner.message.update({
      where: { id: messageId },
      data: { deliveryStatus: DeliveryStatus.QUEUED, channelMessageId: null }
    })
    // The job names another store: the where of the write carries it too, so the row of this store is left as it was
    await expect(
      writer.apply({ storeId: otherStoreId, messageId, to: DeliveryStatus.SENT })
    ).resolves.toBe(false)
    const row = await owner.message.findUniqueOrThrow({ where: { id: messageId } })
    expect(row.deliveryStatus).toBe(DeliveryStatus.QUEUED)
  })

  it('treats a store that was deleted as a job with nothing left to do, and not as an empty answer', async () => {
    const writer = new ReactionStatusWriter(prisma, events as never, jobContext)
    await expect(
      writer.settle({
        storeId: randomUUID(),
        messageId,
        userId: randomUUID(),
        errorCode: null,
        expectedVersion: new Date()
      })
    ).rejects.toBeInstanceOf(JobContextGoneError)
  })
})
