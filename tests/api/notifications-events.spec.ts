import { randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'
import { EventEmitter2 } from '@nestjs/event-emitter'

import { ApiRoutes } from '@platform/core/api'
import { AuditAction } from '@platform/core/audit'
import { Permissions, RoleNames } from '@platform/core/auth'
import type { OwnerClient } from '@platform/core/database-testing'
import { AppPaths, MessageType } from '@platform/core/domain'
import { Events, type MessageChangedPayload } from '@platform/core/events'
import { NotificationTypes } from '@platform/core/notifications'
import { ExportFormats, ExportStatus, ExportTypes } from '@platform/core/queues'

import { createConversationOf, createMessage } from '../builders'
import { actorWithPermissions } from '../helpers/actors'
import { createTestApp } from '../helpers/app'
import { waitForAuditEntries } from '../helpers/audit'
import { createActor, seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { api } from '../helpers/http'

const ATTEMPTS = 50
const POLL_MS = 100
const CREATED = 201

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

// The notifications that the events of the inbox raise (Step 3.5): who is told, and who is not
describe('Notifications raised by events', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  let agent2: { id: string; email: string; token: string }

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp()
    ctx = await seedTestContext(owner, app, prefix)
    agent2 = await createActor(owner, app, {
      prefix,
      name: 'agent2Notified',
      organizationId: ctx.orgA.id,
      storeId: ctx.storeA.id,
      roleId: ctx.roleIds[RoleNames.AGENT]
    })
  })
  afterAll(async () => {
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })
  afterEach(async () => {
    await owner.notification.deleteMany({ where: { storeId: ctx.storeA.id } })
  })

  const rowsOf = (type: string, userId?: string) =>
    owner.notification.findMany({
      where: { storeId: ctx.storeA.id, type, ...(userId === undefined ? {} : { userId }) }
    })
  // The listeners run after the answer: wait for the rows, or for the wait to run out
  async function waitForRows(type: string, expected: number) {
    for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
      const rows = await rowsOf(type)
      if (rows.length >= expected) return rows
      await wait(POLL_MS)
    }
    return rowsOf(type)
  }
  // Nothing to wait for: give a wrong notification the time it would need to appear
  async function settle(type: string) {
    await wait(POLL_MS * 5)
    return rowsOf(type)
  }
  const mk = (extra: Partial<Parameters<typeof createConversationOf>[1]> = {}) =>
    createConversationOf(owner, { storeId: ctx.storeA.id, ...extra })
  const mention = (conversationId: string, userId: string) =>
    api(app, ctx.adminA, ctx.storeA)
      .post(ApiRoutes.messages.create)
      .send({
        type: MessageType.INTERNAL_NOTE,
        conversationId,
        content: 'Check the stock first',
        mentions: [userId]
      })

  describe('a mention', () => {
    it('tells the person mentioned, and only them, with the path of the conversation', async () => {
      const { id } = await mk()

      const response = await mention(id, ctx.agentA.id)
      const rows = await waitForRows(NotificationTypes.CONVERSATION_MENTIONED, 1)

      expect(response.status).toBe(CREATED)
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        userId: ctx.agentA.id,
        actionPath: AppPaths.store.conversation(ctx.storeA.id, id),
        resourceType: 'message'
      })
    })

    it('does not tell the author of a note who mentions themselves', async () => {
      const { id } = await mk()

      const response = await mention(id, ctx.adminA.id)

      expect(response.status).toBe(CREATED)
      expect(await settle(NotificationTypes.CONVERSATION_MENTIONED)).toHaveLength(0)
    })

    it('does not tell someone who lost the right to read the conversation after the note', async () => {
      const { id } = await mk({ assignedTo: agent2.id })
      const events = app.get(EventEmitter2)
      // The mentioned agent is the assignee when the note is written, and is not when the event is heard
      await owner.conversation.update({ where: { id }, data: { assignedTo: ctx.adminA.id } })

      await events.emitAsync(Events.MESSAGE_MENTION, {
        storeId: ctx.storeA.id,
        conversationId: id,
        messageId: randomUUID(),
        mentionedUserId: agent2.id,
        authorId: ctx.adminA.id
      })

      expect(await rowsOf(NotificationTypes.CONVERSATION_MENTIONED)).toHaveLength(0)
    })

    it('does not tell a member of another store, nor one whose role cannot read notes', async () => {
      const { id } = await mk()
      const events = app.get(EventEmitter2)
      const noNotes = await actorWithPermissions(owner, app, {
        prefix,
        name: `noNotes${randomUUID().slice(0, 6)}`,
        organizationId: ctx.orgA.id,
        storeId: ctx.storeA.id,
        permissions: [Permissions.CONVERSATIONS_VIEW, Permissions.MESSAGES_VIEW]
      })
      const emit = (mentionedUserId: string) =>
        events.emitAsync(Events.MESSAGE_MENTION, {
          storeId: ctx.storeA.id,
          conversationId: id,
          messageId: randomUUID(),
          mentionedUserId,
          authorId: ctx.adminA.id
        })

      await emit(noNotes.id)
      await emit(ctx.adminB.id)

      expect(await rowsOf(NotificationTypes.CONVERSATION_MENTIONED)).toHaveLength(0)
    })
  })

  describe('an infected file', () => {
    const infected = (
      conversationId: string,
      messageId: string,
      extra: Partial<MessageChangedPayload> = {}
    ): MessageChangedPayload => ({
      storeId: ctx.storeA.id,
      conversationId,
      messageId,
      internal: false,
      visibility: { hidden: false, assignedTo: null },
      ...extra
    })

    it('tells who may read the conversation, audits it, and tells nobody of another store', async () => {
      const conversation = await mk()
      const message = await createMessage(owner, {
        storeId: ctx.storeA.id,
        conversationId: conversation.id
      })

      await app
        .get(EventEmitter2)
        .emitAsync(Events.MEDIA_INFECTED, infected(conversation.id, message.id))
      const rows = await rowsOf(NotificationTypes.MEDIA_INFECTED)

      const told = rows.map(row => row.userId)
      expect(told).toEqual(expect.arrayContaining([ctx.adminA.id, ctx.agentA.id]))
      expect(told).not.toContain(ctx.adminB.id)
      expect(
        rows.every(
          row => row.actionPath === AppPaths.store.conversation(ctx.storeA.id, conversation.id)
        )
      ).toBe(true)
      const audit = await waitForAuditEntries(owner, {
        storeId: ctx.storeA.id,
        action: AuditAction.MEDIA_INFECTED,
        resourceId: message.id
      })
      expect(audit).toHaveLength(1)
    })

    it('tells each person once when two files of one message are infected', async () => {
      const conversation = await mk()
      const message = await createMessage(owner, {
        storeId: ctx.storeA.id,
        conversationId: conversation.id
      })
      const events = app.get(EventEmitter2)

      await events.emitAsync(Events.MEDIA_INFECTED, infected(conversation.id, message.id))
      const once = (await rowsOf(NotificationTypes.MEDIA_INFECTED)).length
      await events.emitAsync(Events.MEDIA_INFECTED, infected(conversation.id, message.id))

      expect(once).toBeGreaterThan(0)
      expect(await rowsOf(NotificationTypes.MEDIA_INFECTED)).toHaveLength(once)
    })

    it('leaves out who cannot open a conversation assigned to someone else', async () => {
      const conversation = await mk({ assignedTo: ctx.adminA.id })
      const message = await createMessage(owner, {
        storeId: ctx.storeA.id,
        conversationId: conversation.id
      })

      await app.get(EventEmitter2).emitAsync(
        Events.MEDIA_INFECTED,
        infected(conversation.id, message.id, {
          visibility: { hidden: false, assignedTo: ctx.adminA.id }
        })
      )

      const told = (await rowsOf(NotificationTypes.MEDIA_INFECTED)).map(row => row.userId)
      expect(told).toContain(ctx.adminA.id)
      expect(told).not.toContain(agent2.id)
    })

    it('leaves out who cannot read notes when the file belongs to a note', async () => {
      const conversation = await mk()
      const message = await createMessage(owner, {
        storeId: ctx.storeA.id,
        conversationId: conversation.id
      })
      const noNotes = await actorWithPermissions(owner, app, {
        prefix,
        name: `reader${randomUUID().slice(0, 6)}`,
        organizationId: ctx.orgA.id,
        storeId: ctx.storeA.id,
        permissions: [Permissions.CONVERSATIONS_VIEW, Permissions.MESSAGES_VIEW]
      })
      const events = app.get(EventEmitter2)

      await events.emitAsync(
        Events.MEDIA_INFECTED,
        infected(conversation.id, message.id, { internal: true })
      )

      const told = (await rowsOf(NotificationTypes.MEDIA_INFECTED)).map(row => row.userId)
      expect(told).toContain(ctx.adminA.id)
      expect(told).not.toContain(noNotes.id)
    })
  })

  describe('an export that settled', () => {
    const exportOf = (requestedBy: string, status: string, type: string = ExportTypes.CUSTOMERS) =>
      owner.export.create({
        data: {
          storeId: ctx.storeA.id,
          requestedBy,
          type,
          format: ExportFormats.CSV,
          status,
          key: status === ExportStatus.READY ? `exports/${ctx.storeA.id}/x/customers.csv` : null,
          expiresAt: new Date(Date.now() + 86_400_000)
        }
      })
    const settled = (row: { id: string; requestedBy: string; type: string }) => ({
      storeId: ctx.storeA.id,
      exportId: row.id,
      requestedBy: row.requestedBy,
      exportType: row.type
    })

    it('tells who asked for it, with the file name and the path of the center', async () => {
      const row = await exportOf(ctx.adminA.id, ExportStatus.READY)

      await app.get(EventEmitter2).emitAsync(Events.EXPORT_READY, settled(row))

      const rows = await rowsOf(NotificationTypes.EXPORT_READY)
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        userId: ctx.adminA.id,
        actionPath: AppPaths.store.exports(ctx.storeA.id),
        resourceType: 'export',
        resourceId: row.id,
        params: { filename: 'customers.csv', type: ExportTypes.CUSTOMERS }
      })
    })

    it('tells who asked for it that the export failed', async () => {
      const row = await exportOf(ctx.adminA.id, ExportStatus.FAILED)

      await app.get(EventEmitter2).emitAsync(Events.EXPORT_FAILED, settled(row))

      const rows = await rowsOf(NotificationTypes.EXPORT_FAILED, ctx.adminA.id)
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ params: { type: ExportTypes.CUSTOMERS } })
    })

    it('tells nobody when the row is not in the state of the event, is not theirs or is of a kind their role lost', async () => {
      const events = app.get(EventEmitter2)
      const pending = await exportOf(ctx.adminA.id, ExportStatus.PENDING)
      const ready = await exportOf(ctx.adminA.id, ExportStatus.READY)
      const lost = await exportOf(ctx.agentA.id, ExportStatus.READY)

      await events.emitAsync(Events.EXPORT_READY, settled(pending))
      await events.emitAsync(Events.EXPORT_READY, { ...settled(ready), requestedBy: ctx.agentA.id })
      await events.emitAsync(Events.EXPORT_READY, settled(lost))
      await events.emitAsync(Events.EXPORT_READY, { ...settled(ready), exportType: 'orders' })

      expect(await rowsOf(NotificationTypes.EXPORT_READY)).toHaveLength(0)
    })
  })
})
