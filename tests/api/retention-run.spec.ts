import { randomUUID } from 'node:crypto'
import { gunzipSync } from 'node:zlib'

import type { INestApplication } from '@nestjs/common'
import type { PinoLogger } from 'nestjs-pino'

import { AuditAction } from '@platform/core/audit'
import { auditColdExportLockKey, DataRetentionPolicies } from '@platform/core/compliance'
import { JobContext, PrismaService } from '@platform/core/database'
import { connectionUrls, type OwnerClient } from '@platform/core/database-testing'
import { ConversationStatus } from '@platform/core/domain'
import { ImageVariants, MediaPurpose, StorageKeys } from '@platform/core/storage'
import { StorageService } from '@platform/core/storage-module'

import { AuditColdExporter } from '../../apps/worker/src/retention/audit-cold-exporter.service'
import { PlatformCleaner } from '../../apps/worker/src/retention/platform-cleaner.service'
import { StoreRetentionEnforcer } from '../../apps/worker/src/retention/store-retention-enforcer.service'
import { RetentionScheduler } from '../../apps/worker/src/schedulers/retention.scheduler'
import {
  createConversationOf,
  createCustomer,
  createMessage,
  createOrder,
  createWebhook
} from '../builders'
import { createTestApp } from '../helpers/app'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'

const DAY_MS = 86_400_000
const daysAgo = (days: number, from: Date = new Date()): Date =>
  new Date(from.getTime() - days * DAY_MS)

const logger = {
  setContext: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined
} as unknown as PinoLogger

// The retention of the worker (TDD_05 §9.3 and §10.4, Step 5.4 PR B) against the real database (as the role of the worker),
// the real bucket and the real rows of two stores of two organizations. The platform cleanup and the cold export of the
// audit log read the whole database, which the suites beside this one share: they run "in the past" (a clock and
// a date of 2001) so that they reach only the rows this suite made, which are older than anything the others write.
describe('The retention run of the worker', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  let worker: PrismaService
  let storage: StorageService
  let enforcer: StoreRetentionEnforcer
  let cleaner: PlatformCleaner
  let exporter: AuditColdExporter
  const keys: string[] = []

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp()
    ctx = await seedTestContext(owner, app, prefix)
    worker = new PrismaService({ databaseUrl: connectionUrls().worker })
    storage = app.get(StorageService)
    enforcer = new StoreRetentionEnforcer(worker, storage, logger, new JobContext(worker))
    cleaner = new PlatformCleaner(worker, logger)
    exporter = new AuditColdExporter(worker, storage, logger)
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

  // A conversation of the store with a message that carries a file (an original and a thumbnail in the bucket)
  async function conversationWithFile(
    storeId: string,
    input: { status: ConversationStatus; lastMessageAt: Date | null; createdAt?: Date }
  ) {
    const conversation = await createConversationOf(owner, {
      storeId,
      status: input.status,
      lastMessageAt: input.lastMessageAt
    })
    if (input.createdAt !== undefined) {
      await owner.conversation.update({
        where: { id: conversation.id },
        data: { createdAt: input.createdAt }
      })
    }
    const message = await createMessage(owner, { storeId, conversationId: conversation.id })
    const mediaId = randomUUID()
    const key = await putObject(StorageKeys.message(storeId, mediaId, 'a.txt'))
    const thumb = await putObject(StorageKeys.messageVariant(storeId, mediaId, ImageVariants.THUMB))
    await owner.media.create({
      data: {
        id: mediaId,
        storeId,
        purpose: MediaPurpose.MESSAGE,
        messageId: message.id,
        key,
        variants: { [ImageVariants.THUMB]: thumb },
        filename: 'a.txt',
        contentType: 'text/plain',
        fileSize: 1
      }
    })
    return { conversationId: conversation.id, messageId: message.id, mediaId, key, thumb }
  }

  describe('of a store (StoreRetentionEnforcer)', () => {
    beforeEach(async () => {
      await owner.retentionSettings.deleteMany({
        where: { storeId: { in: [ctx.storeA.id, ctx.storeB.id] } }
      })
    })

    it('deletes a resolved conversation past its window with its messages, its files and the objects of them', async () => {
      const old = await conversationWithFile(ctx.storeA.id, {
        status: ConversationStatus.RESOLVED,
        lastMessageAt: daysAgo(800)
      })

      const report = await enforcer.enforce(ctx.storeA.id)

      expect(report.conversations).toBeGreaterThanOrEqual(1)
      expect(await owner.conversation.count({ where: { id: old.conversationId } })).toBe(0)
      expect(await owner.message.count({ where: { id: old.messageId } })).toBe(0)
      expect(await owner.media.count({ where: { id: old.mediaId } })).toBe(0)
      expect(await storage.head(old.key)).toBeNull()
      expect(await storage.head(old.thumb)).toBeNull()
    })

    // The summary or the label of an order, sent in the conversation as a message: the file belongs to the order (TDD_05 §10.4: an order is
    // never touched by the retention of a tenant), so it outlives the message it was sent with
    async function orderDocumentIn(storeId: string, conversationId: string, messageId: string) {
      const order = await createOrder(owner, { storeId })
      const mediaId = randomUUID()
      const key = await putObject(StorageKeys.message(storeId, mediaId, 'summary.pdf'))
      await owner.media.create({
        data: {
          id: mediaId,
          storeId,
          purpose: MediaPurpose.ORDER,
          orderId: order.id,
          messageId,
          key,
          filename: 'summary.pdf',
          contentType: 'application/pdf',
          fileSize: 1
        }
      })
      await owner.order.update({ where: { id: order.id }, data: { conversationId } })
      return { orderId: order.id, mediaId, key }
    }

    it('keeps the document of an order that was sent in a deleted conversation, and deletes the plain file beside it', async () => {
      const old = await conversationWithFile(ctx.storeA.id, {
        status: ConversationStatus.RESOLVED,
        lastMessageAt: daysAgo(800)
      })
      const document = await orderDocumentIn(ctx.storeA.id, old.conversationId, old.messageId)

      await enforcer.enforce(ctx.storeA.id)

      // The conversation, its message and the plain file are gone, with their objects
      expect(await owner.conversation.count({ where: { id: old.conversationId } })).toBe(0)
      expect(await owner.message.count({ where: { id: old.messageId } })).toBe(0)
      expect(await owner.media.count({ where: { id: old.mediaId } })).toBe(0)
      expect(await storage.head(old.key)).toBeNull()
      // The document of the order keeps its row and its object, and only loses the message it was sent with
      const kept = await owner.media.findUniqueOrThrow({ where: { id: document.mediaId } })
      expect(kept.orderId).toBe(document.orderId)
      expect(kept.messageId).toBeNull()
      expect(await storage.head(document.key)).not.toBeNull()
      const order = await owner.order.findUniqueOrThrow({ where: { id: document.orderId } })
      expect(order.conversationId).toBeNull()
    })

    it('keeps the document of an order of an archived conversation too, deletes its plain file, and touches no other store', async () => {
      const mine = await conversationWithFile(ctx.storeA.id, {
        status: ConversationStatus.ARCHIVED,
        lastMessageAt: daysAgo(900)
      })
      const mineDocument = await orderDocumentIn(ctx.storeA.id, mine.conversationId, mine.messageId)
      const theirs = await conversationWithFile(ctx.storeB.id, {
        status: ConversationStatus.RESOLVED,
        lastMessageAt: daysAgo(900)
      })
      const theirDocument = await orderDocumentIn(
        ctx.storeB.id,
        theirs.conversationId,
        theirs.messageId
      )

      await enforcer.enforce(ctx.storeA.id)

      // Store A: the conversation, its message and its plain file are gone; the document stays and the order forgets only the link
      expect(await owner.conversation.count({ where: { id: mine.conversationId } })).toBe(0)
      expect(await owner.message.count({ where: { id: mine.messageId } })).toBe(0)
      expect(await owner.media.count({ where: { id: mine.mediaId } })).toBe(0)
      expect(await storage.head(mine.key)).toBeNull()
      expect(await owner.media.count({ where: { id: mineDocument.mediaId } })).toBe(1)
      expect(await storage.head(mineDocument.key)).not.toBeNull()
      expect(
        (await owner.order.findUniqueOrThrow({ where: { id: mineDocument.orderId } }))
          .conversationId
      ).toBeNull()
      // Store B is not part of this run: its conversation, its file, its document and its order link stay as they were
      expect(await owner.conversation.count({ where: { id: theirs.conversationId } })).toBe(1)
      expect(await owner.media.count({ where: { id: theirs.mediaId } })).toBe(1)
      const theirKept = await owner.media.findUniqueOrThrow({
        where: { id: theirDocument.mediaId }
      })
      expect(theirKept.messageId).toBe(theirs.messageId)
      expect(await storage.head(theirDocument.key)).not.toBeNull()
      expect(
        (await owner.order.findUniqueOrThrow({ where: { id: theirDocument.orderId } }))
          .conversationId
      ).toBe(theirs.conversationId)
    })

    it('keeps the order made from a deleted conversation and removes only its link', async () => {
      const old = await conversationWithFile(ctx.storeA.id, {
        status: ConversationStatus.RESOLVED,
        lastMessageAt: daysAgo(800)
      })
      const order = await createOrder(owner, { storeId: ctx.storeA.id })
      await owner.order.update({
        where: { id: order.id },
        data: { conversationId: old.conversationId }
      })

      await enforcer.enforce(ctx.storeA.id)

      const kept = await owner.order.findUniqueOrThrow({ where: { id: order.id } })
      expect(kept.conversationId).toBeNull()
      expect(await owner.conversation.count({ where: { id: old.conversationId } })).toBe(0)
    })

    it('starts the window over for a conversation that was resolved or archived again after the cutoff', async () => {
      const resolvedAgain = await conversationWithFile(ctx.storeA.id, {
        status: ConversationStatus.RESOLVED,
        lastMessageAt: daysAgo(800)
      })
      await owner.conversation.update({
        where: { id: resolvedAgain.conversationId },
        data: { resolvedAt: daysAgo(2) }
      })
      const archivedAgain = await conversationWithFile(ctx.storeA.id, {
        status: ConversationStatus.ARCHIVED,
        lastMessageAt: daysAgo(800)
      })
      await owner.conversation.update({
        where: { id: archivedAgain.conversationId },
        data: { archivedAt: daysAgo(2) }
      })

      await enforcer.enforce(ctx.storeA.id)

      for (const kept of [resolvedAgain, archivedAgain]) {
        expect(await owner.conversation.count({ where: { id: kept.conversationId } })).toBe(1)
        expect(await storage.head(kept.key)).not.toBeNull()
      }
    })

    it('does not move the updated_at of the order whose conversation link it removes', async () => {
      const old = await conversationWithFile(ctx.storeA.id, {
        status: ConversationStatus.RESOLVED,
        lastMessageAt: daysAgo(800)
      })
      const order = await createOrder(owner, { storeId: ctx.storeA.id })
      await owner.order.update({
        where: { id: order.id },
        data: { conversationId: old.conversationId }
      })
      const before = await owner.order.findUniqueOrThrow({ where: { id: order.id } })

      await enforcer.enforce(ctx.storeA.id)

      const after = await owner.order.findUniqueOrThrow({ where: { id: order.id } })
      expect(after.conversationId).toBeNull()
      expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime())
    })

    it('keeps what is inside the window, and what is not finished however old', async () => {
      const recent = await conversationWithFile(ctx.storeA.id, {
        status: ConversationStatus.RESOLVED,
        lastMessageAt: daysAgo(100)
      })
      const open = await conversationWithFile(ctx.storeA.id, {
        status: ConversationStatus.OPEN,
        lastMessageAt: daysAgo(900)
      })
      const spam = await conversationWithFile(ctx.storeA.id, {
        status: ConversationStatus.SPAM,
        lastMessageAt: daysAgo(900)
      })

      await enforcer.enforce(ctx.storeA.id)

      for (const kept of [recent, open, spam]) {
        expect(await owner.conversation.count({ where: { id: kept.conversationId } })).toBe(1)
        expect(await storage.head(kept.key)).not.toBeNull()
      }
    })

    it('measures a conversation with no message from its creation', async () => {
      const silent = await createConversationOf(owner, {
        storeId: ctx.storeA.id,
        status: ConversationStatus.ARCHIVED,
        lastMessageAt: null
      })
      await owner.conversation.update({
        where: { id: silent.id },
        data: { createdAt: daysAgo(800) }
      })

      await enforcer.enforce(ctx.storeA.id)

      expect(await owner.conversation.count({ where: { id: silent.id } })).toBe(0)
    })

    it('uses the window of the store: a shorter one deletes what the default keeps', async () => {
      const aged = await conversationWithFile(ctx.storeA.id, {
        status: ConversationStatus.RESOLVED,
        lastMessageAt: daysAgo(100)
      })
      await owner.retentionSettings.create({
        data: {
          storeId: ctx.storeA.id,
          conversationDays: 60,
          mediaDays: 365,
          analyticsDays: 395,
          notificationDays: 90
        }
      })

      await enforcer.enforce(ctx.storeA.id)

      expect(await owner.conversation.count({ where: { id: aged.conversationId } })).toBe(0)
    })

    it('never touches another store, whatever the age of what it holds', async () => {
      const other = await conversationWithFile(ctx.storeB.id, {
        status: ConversationStatus.RESOLVED,
        lastMessageAt: daysAgo(3000)
      })
      const event = await owner.analyticsEvent.create({
        data: { storeId: ctx.storeB.id, event: 'test.old', data: {}, date: daysAgo(3000) }
      })
      const note = await owner.notification.create({
        data: {
          userId: ctx.adminB.id,
          storeId: ctx.storeB.id,
          type: 'test',
          severity: 'info',
          messageKey: 'test.old',
          readAt: daysAgo(3000),
          createdAt: daysAgo(3000)
        }
      })

      await enforcer.enforce(ctx.storeA.id)

      expect(await owner.conversation.count({ where: { id: other.conversationId } })).toBe(1)
      expect(await storage.head(other.key)).not.toBeNull()
      expect(await owner.analyticsEvent.count({ where: { id: event.id } })).toBe(1)
      expect(await owner.notification.count({ where: { id: note.id } })).toBe(1)
    })

    it('deletes a message file past mediaDays and leaves its message, and keeps a younger one', async () => {
      const kept = await conversationWithFile(ctx.storeA.id, {
        status: ConversationStatus.OPEN,
        lastMessageAt: new Date()
      })
      const aged = await conversationWithFile(ctx.storeA.id, {
        status: ConversationStatus.OPEN,
        lastMessageAt: new Date()
      })
      await owner.media.update({ where: { id: aged.mediaId }, data: { createdAt: daysAgo(400) } })

      const report = await enforcer.enforce(ctx.storeA.id)

      expect(report.media).toBeGreaterThanOrEqual(1)
      expect(await owner.media.count({ where: { id: aged.mediaId } })).toBe(0)
      expect(await storage.head(aged.key)).toBeNull()
      expect(await storage.head(aged.thumb)).toBeNull()
      expect(await owner.message.count({ where: { id: aged.messageId } })).toBe(1)
      expect(await owner.media.count({ where: { id: kept.mediaId } })).toBe(1)
    })

    it('never deletes an object outside the store, even if a variants column points there', async () => {
      const foreign = await putObject(
        StorageKeys.message(ctx.storeB.id, randomUUID(), 'foreign.txt')
      )
      const mediaId = randomUUID()
      const own = await putObject(StorageKeys.message(ctx.storeA.id, mediaId, 'own.txt'))
      const conversation = await createConversationOf(owner, {
        storeId: ctx.storeA.id,
        status: ConversationStatus.RESOLVED,
        lastMessageAt: daysAgo(800)
      })
      const message = await createMessage(owner, {
        storeId: ctx.storeA.id,
        conversationId: conversation.id
      })
      await owner.media.create({
        data: {
          id: mediaId,
          storeId: ctx.storeA.id,
          purpose: MediaPurpose.MESSAGE,
          messageId: message.id,
          key: own,
          variants: { [ImageVariants.THUMB]: foreign },
          filename: 'own.txt',
          contentType: 'text/plain',
          fileSize: 1
        }
      })

      await enforcer.enforce(ctx.storeA.id)

      expect(await storage.head(own)).toBeNull()
      expect(await storage.head(foreign)).not.toBeNull()
    })

    it('deletes analytics events past their window and read notifications past theirs, never an unread one', async () => {
      const [oldEvent, newEvent] = await Promise.all([
        owner.analyticsEvent.create({
          data: { storeId: ctx.storeA.id, event: 'test.old', data: {}, date: daysAgo(500) }
        }),
        owner.analyticsEvent.create({
          data: { storeId: ctx.storeA.id, event: 'test.new', data: {}, date: daysAgo(10) }
        })
      ])
      const note = (over: { readAt: Date | null; createdAt: Date }) =>
        owner.notification.create({
          data: {
            userId: ctx.adminA.id,
            storeId: ctx.storeA.id,
            type: 'test',
            severity: 'info',
            messageKey: 'test.note',
            ...over
          }
        })
      const readOld = await note({ readAt: daysAgo(100), createdAt: daysAgo(120) })
      const unreadOld = await note({ readAt: null, createdAt: daysAgo(120) })
      const readNew = await note({ readAt: daysAgo(1), createdAt: daysAgo(5) })

      const report = await enforcer.enforce(ctx.storeA.id)

      expect(report.analyticsEvents).toBeGreaterThanOrEqual(1)
      expect(await owner.analyticsEvent.count({ where: { id: oldEvent.id } })).toBe(0)
      expect(await owner.analyticsEvent.count({ where: { id: newEvent.id } })).toBe(1)
      expect(await owner.notification.count({ where: { id: readOld.id } })).toBe(0)
      expect(await owner.notification.count({ where: { id: unreadOld.id } })).toBe(1)
      expect(await owner.notification.count({ where: { id: readNew.id } })).toBe(1)
    })

    it('leaves the orders of the store alone, however old', async () => {
      const customer = await createCustomer(owner, { storeId: ctx.storeA.id })
      await owner.customer.update({
        where: { id: customer.id },
        data: { createdAt: daysAgo(4000) }
      })

      await enforcer.enforce(ctx.storeA.id)

      expect(await owner.customer.count({ where: { id: customer.id } })).toBe(1)
    })
  })

  describe('of the platform (PlatformCleaner)', () => {
    // A clock in 2001: only the rows this suite makes, dated before it, are past their date
    const now = new Date('2001-06-15T12:00:00Z')

    it('deletes the sessions past expiresAt and keeps the live ones', async () => {
      const make = (expiresAt: Date) =>
        owner.session.create({
          data: {
            userId: ctx.adminA.id,
            familyId: randomUUID(),
            refreshTokenHash: randomUUID(),
            expiresAt,
            familyExpiresAt: expiresAt
          }
        })
      const expired = await make(daysAgo(1, now))
      const live = await make(new Date('2001-07-01T00:00:00Z'))

      const report = await cleaner.run(now)

      expect(report.sessions).toBeGreaterThanOrEqual(1)
      expect(await owner.session.count({ where: { id: expired.id } })).toBe(0)
      expect(await owner.session.count({ where: { id: live.id } })).toBe(1)
    })

    it('deletes expired tokens and those used a day ago, and keeps a live one and one used now', async () => {
      const make = (over: { expiresAt: Date; usedAt?: Date }) =>
        owner.verificationToken.create({
          data: {
            type: 'magic_link',
            tokenHash: randomUUID(),
            userId: ctx.adminA.id,
            ...over
          }
        })
      const expired = await make({ expiresAt: daysAgo(1, now) })
      const usedLongAgo = await make({
        expiresAt: new Date('2001-12-01T00:00:00Z'),
        usedAt: daysAgo(2, now)
      })
      const live = await make({ expiresAt: new Date('2001-12-01T00:00:00Z') })
      const usedJustNow = await make({
        expiresAt: new Date('2001-12-01T00:00:00Z'),
        usedAt: new Date(now.getTime() - 60_000)
      })

      await cleaner.run(now)

      const left = await owner.verificationToken.findMany({
        where: { id: { in: [expired.id, usedLongAgo.id, live.id, usedJustNow.id] } },
        select: { id: true }
      })
      expect(left.map(token => token.id).sort()).toEqual([live.id, usedJustNow.id].sort())
    })

    it('deletes the deliveries of a webhook past thirty days and the hours of the rollup past ninety', async () => {
      const webhook = await createWebhook(owner, { storeId: ctx.storeA.id })
      const delivery = (createdAt: Date) =>
        owner.webhookDelivery.create({
          data: {
            webhookId: webhook.id,
            event: 'order.created',
            durationMs: 1,
            success: true,
            createdAt
          }
        })
      const oldDelivery = await delivery(
        daysAgo(DataRetentionPolicies.WEBHOOK_DELIVERIES.defaultDays + 1, now)
      )
      const newDelivery = await delivery(daysAgo(1, now))
      const hour = (at: Date, metric: string) =>
        owner.metricHourly.create({
          data: { storeId: ctx.storeA.id, hour: at, metric, value: 1, count: 1 }
        })
      const oldHour = await hour(
        daysAgo(DataRetentionPolicies.METRICS_HOURLY.defaultDays + 1, now),
        'test.old'
      )
      const newHour = await hour(daysAgo(1, now), 'test.new')

      await cleaner.run(now)

      expect(await owner.webhookDelivery.count({ where: { id: oldDelivery.id } })).toBe(0)
      expect(await owner.webhookDelivery.count({ where: { id: newDelivery.id } })).toBe(1)
      expect(await owner.metricHourly.count({ where: { id: oldHour.id } })).toBe(0)
      expect(await owner.metricHourly.count({ where: { id: newHour.id } })).toBe(1)
    })

    async function merge(over: { unmergeUntil: Date; unmergedAt?: Date; stillAbsorbed?: boolean }) {
      const survivor = await createCustomer(owner, { storeId: ctx.storeA.id })
      const absorbed = await createCustomer(owner, { storeId: ctx.storeA.id })
      if (over.stillAbsorbed ?? true) {
        await owner.customer.update({
          where: { id: absorbed.id },
          data: { mergedIntoId: survivor.id }
        })
      }
      const row = await owner.customerMerge.create({
        data: {
          storeId: ctx.storeA.id,
          survivorId: survivor.id,
          absorbedId: absorbed.id,
          snapshot: {},
          mergedById: ctx.adminA.id,
          unmergeUntil: over.unmergeUntil,
          ...(over.unmergedAt === undefined ? {} : { unmergedAt: over.unmergedAt })
        }
      })
      return { survivor, absorbed, row }
    }

    it('deletes the customer a merge absorbed once the window to undo it has passed, with the merge row', async () => {
      const past = await merge({ unmergeUntil: daysAgo(1, now) })
      const within = await merge({ unmergeUntil: new Date('2001-07-01T00:00:00Z') })

      const report = await cleaner.run(now)

      expect(report.mergedCustomers).toBeGreaterThanOrEqual(1)
      expect(await owner.customer.count({ where: { id: past.absorbed.id } })).toBe(0)
      expect(await owner.customerMerge.count({ where: { id: past.row.id } })).toBe(0)
      expect(await owner.customer.count({ where: { id: past.survivor.id } })).toBe(1)
      expect(await owner.customer.count({ where: { id: within.absorbed.id } })).toBe(1)
      expect(await owner.customerMerge.count({ where: { id: within.row.id } })).toBe(1)
    })

    it('deletes only the row of a merge that was undone, and never a live customer', async () => {
      const undone = await merge({
        unmergeUntil: daysAgo(1, now),
        unmergedAt: daysAgo(10, now),
        stillAbsorbed: false
      })
      // Not undone on record, but the customer is live (nothing absorbed it): the guard keeps it
      const live = await merge({ unmergeUntil: daysAgo(1, now), stillAbsorbed: false })

      await cleaner.run(now)

      expect(await owner.customerMerge.count({ where: { id: undone.row.id } })).toBe(0)
      expect(await owner.customer.count({ where: { id: undone.absorbed.id } })).toBe(1)
      expect(await owner.customerMerge.count({ where: { id: live.row.id } })).toBe(0)
      expect(await owner.customer.count({ where: { id: live.absorbed.id } })).toBe(1)
    })

    it('leaves a customer the database will not delete, and goes on with the rest', async () => {
      const blocked = await merge({ unmergeUntil: daysAgo(1, now) })
      // A conversation still points to the absorbed customer: the restrict key refuses
      await createConversationOf(owner, { storeId: ctx.storeA.id }).then(conversation =>
        owner.conversation.update({
          where: { id: conversation.id },
          data: { customerId: blocked.absorbed.id }
        })
      )
      const fine = await merge({ unmergeUntil: daysAgo(1, now) })

      await cleaner.run(now)

      expect(await owner.customer.count({ where: { id: blocked.absorbed.id } })).toBe(1)
      expect(await owner.customerMerge.count({ where: { id: blocked.row.id } })).toBe(1)
      expect(await owner.customer.count({ where: { id: fine.absorbed.id } })).toBe(0)
    })

    it('keeps the audit entry of a merge: the cleanup does not reach audit_logs', async () => {
      const entry = await owner.auditLog.create({
        data: {
          action: AuditAction.CUSTOMER_MERGED,
          storeId: ctx.storeA.id,
          timestamp: daysAgo(40, now)
        }
      })

      await cleaner.run(now)

      expect(await owner.auditLog.count({ where: { id: entry.id } })).toBe(1)
    })
  })

  describe('of the audit log (AuditColdExporter)', () => {
    // Whole months of 2001 and the clock of the call in mid 2001: older than everything the other suites write
    const before = new Date('2001-06-15T00:00:00Z')
    const archived: string[] = []

    const entry = (at: string, action: string) =>
      owner.auditLog.create({ data: { action, storeId: ctx.storeA.id, timestamp: new Date(at) } })
    const linesOf = async (key: string): Promise<{ id: string; action: string }[]> => {
      const body = await storage.stream(key)
      if (body === null) throw new Error('no object')
      const chunks: Buffer[] = []
      for await (const chunk of body) chunks.push(chunk as Buffer)
      return gunzipSync(Buffer.concat(chunks))
        .toString('utf8')
        .trim()
        .split('\n')
        .map(line => JSON.parse(line) as { id: string; action: string })
    }

    afterEach(async () => {
      await owner.auditLog.deleteMany({
        where: { storeId: ctx.storeA.id, timestamp: { lt: before } }
      })
      for (const key of archived.splice(0)) await storage.delete(key).catch(() => undefined)
    })

    it('copies a whole month past the window to the bucket, verifies it, and only then deletes the rows', async () => {
      const marker = `test.cold.${randomUUID().slice(0, 8)}`
      const rows = [
        await entry('2001-03-01T00:00:00Z', marker),
        await entry('2001-03-15T10:00:00Z', marker),
        await entry('2001-03-31T23:59:59Z', marker)
      ]

      const report = await exporter.run(before)

      const march = report.months.find(month => month.year === 2001 && month.month === 3)
      expect(march?.rows).toBe(3)
      const key = StorageKeys.auditArchive(2001, 3)
      archived.push(key)
      expect(march?.key).toBe(key)
      const lines = await linesOf(key)
      expect(lines.map(line => line.id).sort()).toEqual(rows.map(row => row.id).sort())
      expect(await owner.auditLog.count({ where: { id: { in: rows.map(row => row.id) } } })).toBe(0)
    })

    it('leaves a month that is not entirely past the window, and anything newer', async () => {
      const inside = await entry('2001-06-02T00:00:00Z', 'test.cold.inside')
      const recent = await entry(new Date().toISOString(), 'test.cold.recent')

      const report = await exporter.run(before)

      expect(report.months.some(month => month.month === 6 && month.year === 2001)).toBe(false)
      expect(await owner.auditLog.count({ where: { id: inside.id } })).toBe(1)
      expect(await owner.auditLog.count({ where: { id: recent.id } })).toBe(1)
      await owner.auditLog.delete({ where: { id: recent.id } })
    })

    it('does not delete a row when the copy cannot be verified, and does not overwrite an archived month', async () => {
      const first = await entry('2001-04-10T00:00:00Z', 'test.cold.first')
      await exporter.run(before)
      const key1 = StorageKeys.auditArchive(2001, 4)
      archived.push(key1)
      // The delete of that run "did not finish": a row of the month is back, and the object of the month is there
      const again = await owner.auditLog.create({
        data: {
          id: first.id,
          action: 'test.cold.first',
          storeId: ctx.storeA.id,
          timestamp: first.timestamp
        }
      })

      const report = await exporter.run(before)

      const key2 = StorageKeys.auditArchive(2001, 4, 2)
      archived.push(key2)
      expect(report.months.find(month => month.month === 4)?.key).toBe(key2)
      expect((await linesOf(key1)).map(line => line.id)).toEqual([first.id])
      expect((await linesOf(key2)).map(line => line.id)).toEqual([again.id])
      expect(await owner.auditLog.count({ where: { id: again.id } })).toBe(0)
    })

    it('leaves a month to the run that holds its lock: it writes no object and deletes no row', async () => {
      // A month that no other case of this suite uses (1987), so that no other run can have written its object; cleaned up
      // even when an assertion below fails, and proved empty first: an object here before the run would not be the run's
      const lockedKey = StorageKeys.auditArchive(1987, 3)
      await storage.delete(lockedKey).catch(() => undefined)
      archived.push(lockedKey)
      expect(await storage.head(lockedKey)).toBeNull()
      const row = await entry('1987-03-10T00:00:00Z', 'test.cold.locked')
      const key = auditColdExportLockKey(1987, 3)

      const report = await worker.transaction(
        async tx => {
          await tx.$queryRaw`SELECT 1 AS locked FROM (SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))) AS lock`
          return exporter.run(before)
        },
        { timeout: 30_000 }
      )

      expect(report.busy).toEqual({ year: 1987, month: 3 })
      expect(report.months).toEqual([])
      expect(await storage.head(lockedKey)).toBeNull()
      expect(await owner.auditLog.count({ where: { id: row.id } })).toBe(1)
      // Once the other run is over (its lock is gone) the month goes
      const after = await exporter.run(before)
      expect(after.busy).toBeNull()
      expect(after.months.find(month => month.year === 1987 && month.month === 3)?.rows).toBe(1)
    })

    it('exports a month once when two runs meet: one object, every row in it, none lost', async () => {
      const rows = [
        await entry('2001-02-03T00:00:00Z', 'test.cold.twice'),
        await entry('2001-02-20T00:00:00Z', 'test.cold.twice')
      ]

      const reports = await Promise.all([exporter.run(before), exporter.run(before)])

      const key = StorageKeys.auditArchive(2001, 2)
      archived.push(key, StorageKeys.auditArchive(2001, 2, 2))
      expect(
        reports.flatMap(report => report.months).filter(month => month.month === 2)
      ).toHaveLength(1)
      expect(await storage.head(StorageKeys.auditArchive(2001, 2, 2))).toBeNull()
      expect((await linesOf(key)).map(line => line.id).sort()).toEqual(
        rows.map(row => row.id).sort()
      )
      expect(await owner.auditLog.count({ where: { id: { in: rows.map(row => row.id) } } })).toBe(0)
    })

    it('holds a job to the end of the hot window, whatever instant it names', async () => {
      const young = await entry(daysAgo(40).toISOString(), 'test.cold.young')
      const middling = await entry(daysAgo(600).toISOString(), 'test.cold.middling')

      // A hand-added job that says "everything before now"
      const report = await exporter.run(new Date())

      expect(report.months.every(month => month.year <= new Date().getUTCFullYear() - 2)).toBe(true)
      expect(await owner.auditLog.count({ where: { id: young.id } })).toBe(1)
      expect(await owner.auditLog.count({ where: { id: middling.id } })).toBe(1)
      await owner.auditLog.deleteMany({ where: { id: { in: [young.id, middling.id] } } })
    })

    it('is a delete only the worker role may make: the role of the api cannot delete from audit_logs', async () => {
      const row = await entry('2001-02-01T00:00:00Z', 'test.cold.role')

      await expect(
        app.get(PrismaService).client.auditLog.delete({ where: { id: row.id } })
      ).rejects.toThrow()
      expect(await owner.auditLog.count({ where: { id: row.id } })).toBe(1)
    })

    it('reads the same bytes it wrote: the object is the gzip of one JSON line for each row', async () => {
      const marker = `test.cold.${randomUUID().slice(0, 8)}`
      await entry('2001-01-05T00:00:00Z', marker)
      await exporter.run(before)
      const key = StorageKeys.auditArchive(2001, 1)
      archived.push(key)

      const stored = await storage.head(key)

      expect(stored?.contentType).toBe('application/gzip')
      expect((await linesOf(key))[0]?.action).toBe(marker)
    })
  })

  describe('the hourly scheduler (RetentionScheduler)', () => {
    it('queues the stores whose own clock reads 03:00, once a local day, and no other', async () => {
      await owner.store.update({
        where: { id: ctx.storeA.id },
        data: { timezone: 'America/El_Salvador' }
      })
      await owner.store.update({ where: { id: ctx.storeB.id }, data: { timezone: 'Asia/Tokyo' } })
      const added: { name: string; data: { storeId: string }; opts: { jobId: string } }[] = []
      const queue = {
        addBulk: (jobs: typeof added) => {
          added.push(...jobs)
          return Promise.resolve()
        }
      }
      const scheduler = new RetentionScheduler(
        { withLock: () => Promise.resolve(true) } as never,
        queue as never,
        worker,
        logger
      )

      // 09:00 UTC is 03:00 in El Salvador (UTC-6) and 18:00 in Tokyo
      await scheduler.enqueueDue(new Date('2026-11-14T09:30:00Z'))

      const mine = added.filter(job => [ctx.storeA.id, ctx.storeB.id].includes(job.data.storeId))
      expect(mine.map(job => job.data.storeId)).toEqual([ctx.storeA.id])
      expect(mine[0]?.opts.jobId).toBe(`enforce-retention-${ctx.storeA.id}-2026-11-14`)
    })
  })
})
