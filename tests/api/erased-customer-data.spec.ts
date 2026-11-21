import { randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'
import type { PinoLogger } from 'nestjs-pino'

import { ApiRoutes } from '@platform/core/api'
import { ComplianceConfig } from '@platform/core/compliance'
import { JobContext, PrismaService } from '@platform/core/database'
import { connectionUrls, type OwnerClient } from '@platform/core/database-testing'
import { MessageType } from '@platform/core/domain'
import { ErrorCodes } from '@platform/core/errors'
import { MediaPurpose, StorageKeys } from '@platform/core/storage'
import { StorageService } from '@platform/core/storage-module'

import { ErasedCustomerData } from '../../apps/worker/src/retention/erased-customer-data.service'
import { ErasedCustomerSweep } from '../../apps/worker/src/retention/erased-customer-sweep.service'
import { createConversationOf, createMessage, createOrder } from '../builders'
import { createTestApp } from '../helpers/app'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { api } from '../helpers/http'

const CONFLICT = 409
const PLACEHOLDER = ComplianceConfig.ERASED_CONTENT_PLACEHOLDER
const SAID = 'My address is 5 Calle Poniente and my phone is 7000 1234'

const logger = {
  setContext: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined
} as unknown as PinoLogger

// What hangs from an erased customer (Step 7.2-C) against the real database (as the role of the worker) and the real bucket
describe('The data of an erased customer', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  let worker: PrismaService
  let storage: StorageService
  let eraser: ErasedCustomerData
  const keys: string[] = []

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp()
    ctx = await seedTestContext(owner, app, prefix)
    worker = new PrismaService({ databaseUrl: connectionUrls().worker })
    storage = app.get(StorageService)
    eraser = new ErasedCustomerData(worker, new JobContext(worker), storage, logger)
  })
  afterAll(async () => {
    for (const key of keys) await storage.delete(key).catch(() => undefined)
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })

  async function putObject(key: string): Promise<string> {
    await storage.put(key, Buffer.from('x'), 'text/plain')
    keys.push(key)
    return key
  }

  async function fileOf(
    storeId: string,
    messageId: string,
    customerId: string | null,
    over: { orderId?: string } = {}
  ) {
    const mediaId = randomUUID()
    const key = await putObject(StorageKeys.message(storeId, mediaId, 'a.txt'))
    await owner.media.create({
      data: {
        id: mediaId,
        storeId,
        purpose: MediaPurpose.MESSAGE,
        messageId,
        ...(customerId === null ? {} : { customerId }),
        ...(over.orderId === undefined ? {} : { orderId: over.orderId }),
        key,
        filename: 'a.txt',
        contentType: 'text/plain',
        fileSize: 1
      }
    })
    return { mediaId, key }
  }

  // A customer that was erased (as the owner of the database: the erasure itself is tested apart) with a thread, a survey, a notification and
  // two files, and a thread of another customer of the same store that must stay as it is
  async function erasedWithThread(storeId = ctx.storeA.id) {
    const conversation = await createConversationOf(owner, { storeId })
    await owner.customer.update({
      where: { id: conversation.customerId },
      data: { erasedAt: new Date() }
    })
    const inbound = await createMessage(owner, {
      storeId,
      conversationId: conversation.id,
      content: SAID,
      metadata: { quoted: SAID }
    })
    const note = await createMessage(owner, {
      storeId,
      conversationId: conversation.id,
      type: MessageType.INTERNAL_NOTE,
      content: 'She prefers calls'
    })
    const system = await createMessage(owner, {
      storeId,
      conversationId: conversation.id,
      type: MessageType.SYSTEM,
      content: 'Resolved',
      metadata: { event: 'resolved' }
    })
    await owner.message.update({ where: { id: inbound.id }, data: { pendingContent: SAID } })
    await owner.messageRevision.create({
      data: {
        storeId,
        messageId: inbound.id,
        version: 1,
        content: SAID,
        editedByType: 'AGENT'
      }
    })
    await owner.conversation.update({
      where: { id: conversation.id },
      data: { csatScore: 4, csatComment: SAID }
    })
    const member = await owner.membership.findFirstOrThrow({
      where: { storeId },
      select: { userId: true }
    })
    const notification = await owner.notification.create({
      data: {
        userId: member.userId,
        storeId,
        type: 'conversation.assigned',
        severity: 'info',
        messageKey: 'notifications.conversation.assigned',
        params: { customer: 'Maria Quintanilla', other: 'kept' },
        resourceType: 'conversation',
        resourceId: conversation.id
      }
    })
    const file = await fileOf(storeId, inbound.id, conversation.customerId)
    const reaction = await fileOf(storeId, note.id, null)

    const bystander = await createConversationOf(owner, { storeId })
    const bystanderMessage = await createMessage(owner, {
      storeId,
      conversationId: bystander.id,
      content: 'a live customer'
    })
    const bystanderFile = await fileOf(storeId, bystanderMessage.id, bystander.customerId)
    return {
      conversation,
      inbound,
      note,
      system,
      notification,
      file,
      reaction,
      bystander,
      bystanderMessage,
      bystanderFile
    }
  }

  it('replaces the text of its messages, the text waiting for an edit and its metadata, and leaves the system lines', async () => {
    const t = await erasedWithThread()

    const report = await eraser.clear(ctx.storeA.id, t.conversation.customerId)

    expect(report.cleared).toBe(true)
    const inbound = await owner.message.findUniqueOrThrow({ where: { id: t.inbound.id } })
    expect(inbound).toMatchObject({ content: PLACEHOLDER, pendingContent: null, metadata: null })
    // A note about the person is text about the person
    expect((await owner.message.findUniqueOrThrow({ where: { id: t.note.id } })).content).toBe(
      PLACEHOLDER
    )
    // A system line holds no word of the person: it keeps what it says
    const system = await owner.message.findUniqueOrThrow({ where: { id: t.system.id } })
    expect(system.metadata).toEqual({ event: 'resolved' })
    // The rows stay for the metrics
    expect(await owner.message.count({ where: { conversationId: t.conversation.id } })).toBe(3)
  })

  it('deletes the past versions of an edit, the comment of the survey and keeps its score', async () => {
    const t = await erasedWithThread()

    await eraser.clear(ctx.storeA.id, t.conversation.customerId)

    expect(await owner.messageRevision.count({ where: { messageId: t.inbound.id } })).toBe(0)
    expect(
      await owner.conversation.findUniqueOrThrow({
        where: { id: t.conversation.id },
        select: { csatScore: true, csatComment: true }
      })
    ).toEqual({ csatScore: 4, csatComment: null })
  })

  it('takes the name out of the notifications about its conversations, and nothing else out of them', async () => {
    const t = await erasedWithThread()

    await eraser.clear(ctx.storeA.id, t.conversation.customerId)

    const notification = await owner.notification.findUniqueOrThrow({
      where: { id: t.notification.id }
    })
    expect(notification.params).toEqual({ customer: PLACEHOLDER, other: 'kept' })
  })

  it('deletes the files of its messages, the objects and the rows, and no file of another customer', async () => {
    const t = await erasedWithThread()

    const report = await eraser.clear(ctx.storeA.id, t.conversation.customerId)

    expect(report.files).toBe(2)
    for (const file of [t.file, t.reaction]) {
      expect(await owner.media.count({ where: { id: file.mediaId } })).toBe(0)
      expect(await storage.head(file.key)).toBeNull()
    }
    expect(await owner.media.count({ where: { id: t.bystanderFile.mediaId } })).toBe(1)
    expect(await storage.head(t.bystanderFile.key)).not.toBeNull()
    expect(
      (await owner.message.findUniqueOrThrow({ where: { id: t.bystanderMessage.id } })).content
    ).toBe('a live customer')
  })

  it('keeps the document of an order, which the books need, and its object', async () => {
    const t = await erasedWithThread()
    const order = await createOrder(owner, { storeId: ctx.storeA.id })
    const document = await fileOf(ctx.storeA.id, t.inbound.id, t.conversation.customerId, {
      orderId: order.id
    })

    await eraser.clear(ctx.storeA.id, t.conversation.customerId)

    expect(await owner.media.count({ where: { id: document.mediaId } })).toBe(1)
    expect(await storage.head(document.key)).not.toBeNull()
  })

  it('marks the customer as cleared, and does nothing the second time', async () => {
    const t = await erasedWithThread()
    await eraser.clear(ctx.storeA.id, t.conversation.customerId)
    const marked = await owner.customer.findUniqueOrThrow({
      where: { id: t.conversation.customerId },
      select: { erasedDataPurgedAt: true }
    })
    expect(marked.erasedDataPurgedAt).not.toBeNull()

    const again = await eraser.clear(ctx.storeA.id, t.conversation.customerId)

    expect(again).toMatchObject({ cleared: true, messages: 0, files: 0 })
  })

  it('finishes what a bucket that failed halfway left, on the next run', async () => {
    const t = await erasedWithThread()
    const real = storage.delete.bind(storage)
    const failing = jest.spyOn(storage, 'delete').mockImplementation(key => {
      if (key === t.file.key) return Promise.reject(new Error('the bucket is down'))
      return real(key)
    })
    try {
      const first = await eraser.clear(ctx.storeA.id, t.conversation.customerId)

      // The row of the file that stays is the one that tells the next run where to go on
      expect(first).toMatchObject({ cleared: false, filesLeft: 1, files: 1 })
      expect(await owner.media.count({ where: { id: t.file.mediaId } })).toBe(1)
      expect(
        (
          await owner.customer.findUniqueOrThrow({
            where: { id: t.conversation.customerId },
            select: { erasedDataPurgedAt: true }
          })
        ).erasedDataPurgedAt
      ).toBeNull()
    } finally {
      failing.mockRestore()
    }

    const second = await eraser.clear(ctx.storeA.id, t.conversation.customerId)

    expect(second).toMatchObject({ cleared: true, filesLeft: 0 })
    expect(await owner.media.count({ where: { id: t.file.mediaId } })).toBe(0)
    expect(await storage.head(t.file.key)).toBeNull()
  })

  it('refuses a customer who was not erased, and touches nothing of theirs', async () => {
    const live = await createConversationOf(owner, { storeId: ctx.storeA.id })
    const message = await createMessage(owner, {
      storeId: ctx.storeA.id,
      conversationId: live.id,
      content: SAID
    })
    await owner.conversation.update({ where: { id: live.id }, data: { csatComment: SAID } })

    const report = await eraser.clear(ctx.storeA.id, live.customerId)

    expect(report).toMatchObject({ cleared: false, messages: 0 })
    expect((await owner.message.findUniqueOrThrow({ where: { id: message.id } })).content).toBe(
      SAID
    )
    expect(
      (await owner.conversation.findUniqueOrThrow({ where: { id: live.id } })).csatComment
    ).toBe(SAID)
  })

  it('does not reach a customer of another store, even when the id is right', async () => {
    const t = await erasedWithThread(ctx.storeB.id)

    const report = await eraser.clear(ctx.storeA.id, t.conversation.customerId)

    expect(report.cleared).toBe(false)
    expect((await owner.message.findUniqueOrThrow({ where: { id: t.inbound.id } })).content).toBe(
      SAID
    )
    expect(await owner.media.count({ where: { id: t.file.mediaId } })).toBe(1)
  })

  describe('the daily sweep', () => {
    it('finds an erased customer that was not cleared, and clears it', async () => {
      const t = await erasedWithThread()
      const sweep = new ErasedCustomerSweep(worker, new JobContext(worker), eraser, logger)

      const report = await sweep.run()

      expect(report.cleared).toBeGreaterThanOrEqual(1)
      expect((await owner.message.findUniqueOrThrow({ where: { id: t.inbound.id } })).content).toBe(
        PLACEHOLDER
      )
      expect(await owner.media.count({ where: { id: t.file.mediaId } })).toBe(0)
    })
  })

  describe('a conversation of an erased customer', () => {
    it('refuses a reply with its own code, and writes nothing', async () => {
      const t = await erasedWithThread()
      const before = await owner.message.count({ where: { conversationId: t.conversation.id } })

      const response = await api(app, ctx.adminA, ctx.storeA).post(ApiRoutes.messages.create).send({
        conversationId: t.conversation.id,
        type: MessageType.TEXT,
        content: 'hello again',
        idempotencyKey: randomUUID()
      })

      expect(response.status).toBe(CONFLICT)
      expect((response.body as { error: { code: string } }).error.code).toBe(
        ErrorCodes.CUSTOMER_ERASED
      )
      expect(await owner.message.count({ where: { conversationId: t.conversation.id } })).toBe(
        before
      )
    })

    it('refuses an internal note too: a note would put words about the person back', async () => {
      const t = await erasedWithThread()

      const response = await api(app, ctx.adminA, ctx.storeA).post(ApiRoutes.messages.create).send({
        conversationId: t.conversation.id,
        type: MessageType.INTERNAL_NOTE,
        content: 'she called',
        idempotencyKey: randomUUID()
      })

      expect(response.status).toBe(CONFLICT)
    })
  })
})
