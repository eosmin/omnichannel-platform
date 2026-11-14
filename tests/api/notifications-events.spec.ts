import { randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'
import { EventEmitter2 } from '@nestjs/event-emitter'

import { ApiRoutes } from '@platform/core/api'
import { AuditAction } from '@platform/core/audit'
import { Permissions, RoleNames } from '@platform/core/auth'
import type { OwnerClient } from '@platform/core/database-testing'
import { AppPaths, ConversationStatus, MembershipStatus, MessageType } from '@platform/core/domain'
import { ErrorCodes } from '@platform/core/errors'
import {
  type ConversationAssignedPayload,
  type ConversationSnoozeExpiredPayload,
  Events,
  type MessageChangedPayload
} from '@platform/core/events'
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

  // A member of the store whose access was suspended: still on the team, with the role of an agent
  async function suspendedAgent() {
    const suspended = await createActor(owner, app, {
      prefix,
      name: `suspendedNotified${randomUUID().slice(0, 6)}`,
      organizationId: ctx.orgA.id,
      storeId: ctx.storeA.id,
      roleId: ctx.roleIds[RoleNames.AGENT]
    })
    await owner.membership.updateMany({
      where: { userId: suspended.id, storeId: ctx.storeA.id },
      data: { status: MembershipStatus.SUSPENDED }
    })
    return suspended
  }

  describe('a mention', () => {
    it('does not tell a member who is suspended', async () => {
      const suspended = await suspendedAgent()
      const { id } = await mk()

      await app.get(EventEmitter2).emitAsync(Events.MESSAGE_MENTION, {
        storeId: ctx.storeA.id,
        conversationId: id,
        messageId: randomUUID(),
        mentionedUserId: suspended.id,
        authorId: ctx.adminA.id
      })

      expect(await rowsOf(NotificationTypes.CONVERSATION_MENTIONED)).toHaveLength(0)
    })

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

    it('names who wrote the note and whose conversation it is, for the texts', async () => {
      const { id, customerId } = await mk()
      await owner.customer.update({ where: { id: customerId }, data: { name: 'Lucia Prechat' } })

      await mention(id, ctx.agentA.id)
      const rows = await waitForRows(NotificationTypes.CONVERSATION_MENTIONED, 1)

      const author = await owner.user.findUniqueOrThrow({ where: { id: ctx.adminA.id } })
      expect(rows[0]?.params).toEqual({ author: author.name, customer: 'Lucia Prechat' })
    })

    it('cuts and cleans a name the customer chose before it goes into a text', async () => {
      const { id, customerId } = await mk()
      await owner.customer.update({
        where: { id: customerId },
        data: { name: `Soporte\u202E\n${'x'.repeat(300)}` }
      })

      await mention(id, ctx.agentA.id)
      const rows = await waitForRows(NotificationTypes.CONVERSATION_MENTIONED, 1)

      const { customer } = rows[0]?.params as { customer: string }
      expect(Array.from(customer)).toHaveLength(80)
      expect(customer).toMatch(/^Soporte x+$/)
    })

    it('names a customer with no name by the end of the handle, never by the whole handle', async () => {
      const { id, customerId, customerIdentityId } = await mk()
      await owner.customer.update({ where: { id: customerId }, data: { name: null } })
      await owner.customerIdentity.update({
        where: { id: customerIdentityId },
        data: { displayName: null, channelIdentity: 'visitor-0000-ab98' }
      })

      await mention(id, ctx.agentA.id)
      const rows = await waitForRows(NotificationTypes.CONVERSATION_MENTIONED, 1)

      const params = rows[0]?.params as { customer: string }
      expect(params.customer).toBe('····ab98')
      expect(params.customer).toMatch(/^····\S{1,4}$/)
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

  describe('an assignment', () => {
    const OK = 200
    const assign = (conversationId: string, userId: string | null) =>
      api(app, ctx.adminA, ctx.storeA)
        .patch(ApiRoutes.conversations.assign(conversationId))
        .send({ userId })
    const assigned = (
      conversationId: string,
      assignedTo: string | null,
      extra: Partial<ConversationAssignedPayload> = {}
    ): ConversationAssignedPayload => ({
      storeId: ctx.storeA.id,
      conversationId,
      assignedTo,
      previousAssignee: null,
      assignedBy: { type: 'user', id: ctx.adminA.id },
      visibility: { hidden: false, assignedTo },
      ...extra
    })

    it('tells the agent who is given a conversation, with its path', async () => {
      const { id } = await mk()

      const response = await assign(id, ctx.agentA.id)
      const rows = await waitForRows(NotificationTypes.CONVERSATION_ASSIGNED, 1)

      expect(response.status).toBe(OK)
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        userId: ctx.agentA.id,
        actionPath: AppPaths.store.conversation(ctx.storeA.id, id),
        resourceType: 'conversation',
        resourceId: id
      })
    })

    it('tells nobody when it is taken by the person who took it, or given to nobody', async () => {
      const { id } = await mk()
      const events = app.get(EventEmitter2)

      await events.emitAsync(Events.CONVERSATION_ASSIGNED, assigned(id, ctx.adminA.id))
      await events.emitAsync(Events.CONVERSATION_ASSIGNED, assigned(id, null))

      expect(await rowsOf(NotificationTypes.CONVERSATION_ASSIGNED)).toHaveLength(0)
    })

    it('tells the agent when the system gave it, by a rule or the worker', async () => {
      const { id } = await mk({ assignedTo: ctx.agentA.id })

      await app
        .get(EventEmitter2)
        .emitAsync(
          Events.CONVERSATION_ASSIGNED,
          assigned(id, ctx.agentA.id, { assignedBy: { type: 'system', id: null } })
        )

      expect(await rowsOf(NotificationTypes.CONVERSATION_ASSIGNED, ctx.agentA.id)).toHaveLength(1)
    })

    it('does not tell someone who is no longer active, nor one who cannot open it', async () => {
      const suspended = await suspendedAgent()
      const noView = await actorWithPermissions(owner, app, {
        prefix,
        name: `noView${randomUUID().slice(0, 6)}`,
        organizationId: ctx.orgA.id,
        storeId: ctx.storeA.id,
        permissions: [Permissions.CUSTOMERS_VIEW]
      })
      const events = app.get(EventEmitter2)
      for (const userId of [suspended.id, noView.id, ctx.adminB.id]) {
        const { id } = await mk({ assignedTo: userId })
        await events.emitAsync(Events.CONVERSATION_ASSIGNED, assigned(id, userId))
      }

      expect(await rowsOf(NotificationTypes.CONVERSATION_ASSIGNED)).toHaveLength(0)
    })

    it('tells nobody when the assignment changes nothing', async () => {
      const { id } = await mk({ assignedTo: ctx.agentA.id })

      await app
        .get(EventEmitter2)
        .emitAsync(
          Events.CONVERSATION_ASSIGNED,
          assigned(id, ctx.agentA.id, { previousAssignee: ctx.agentA.id })
        )

      expect(await rowsOf(NotificationTypes.CONVERSATION_ASSIGNED)).toHaveLength(0)
    })

    it('reads the assignee from the row: one that went to someone else meanwhile tells the first nobody', async () => {
      const { id } = await mk({ assignedTo: ctx.adminA.id })

      await app
        .get(EventEmitter2)
        .emitAsync(Events.CONVERSATION_ASSIGNED, assigned(id, ctx.agentA.id))

      expect(await rowsOf(NotificationTypes.CONVERSATION_ASSIGNED)).toHaveLength(0)
    })
  })

  describe('a snooze that ran out', () => {
    const expired = (
      conversationId: string,
      assignedTo: string | null
    ): ConversationSnoozeExpiredPayload => ({
      storeId: ctx.storeA.id,
      conversationId,
      assignedTo
    })

    it('tells the assignee, with the path of the conversation', async () => {
      const { id } = await mk({ assignedTo: ctx.agentA.id })

      await app
        .get(EventEmitter2)
        .emitAsync(Events.CONVERSATION_SNOOZE_EXPIRED, expired(id, ctx.agentA.id))

      const rows = await rowsOf(NotificationTypes.CONVERSATION_SNOOZE_EXPIRED)
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        userId: ctx.agentA.id,
        actionPath: AppPaths.store.conversation(ctx.storeA.id, id),
        resourceType: 'conversation',
        resourceId: id
      })
    })

    it('tells nobody when the conversation has no assignee: the queue is not one person', async () => {
      const { id } = await mk()

      await app.get(EventEmitter2).emitAsync(Events.CONVERSATION_SNOOZE_EXPIRED, expired(id, null))

      expect(await rowsOf(NotificationTypes.CONVERSATION_SNOOZE_EXPIRED)).toHaveLength(0)
    })

    it('reads the assignee from the row, not from the event: it may have changed since', async () => {
      const { id } = await mk({ assignedTo: ctx.adminA.id })

      await app
        .get(EventEmitter2)
        .emitAsync(Events.CONVERSATION_SNOOZE_EXPIRED, expired(id, ctx.agentA.id))

      expect(await rowsOf(NotificationTypes.CONVERSATION_SNOOZE_EXPIRED)).toHaveLength(0)
    })

    it('tells nobody when the conversation was resolved or snoozed again since', async () => {
      for (const status of [ConversationStatus.RESOLVED, ConversationStatus.SNOOZED]) {
        const { id } = await mk({ assignedTo: ctx.agentA.id, status })

        await app
          .get(EventEmitter2)
          .emitAsync(Events.CONVERSATION_SNOOZE_EXPIRED, expired(id, ctx.agentA.id))
      }

      expect(await rowsOf(NotificationTypes.CONVERSATION_SNOOZE_EXPIRED)).toHaveLength(0)
    })

    it('does not tell a member who is suspended', async () => {
      const suspended = await suspendedAgent()
      const { id } = await mk({ assignedTo: suspended.id })

      await app
        .get(EventEmitter2)
        .emitAsync(Events.CONVERSATION_SNOOZE_EXPIRED, expired(id, suspended.id))

      expect(await rowsOf(NotificationTypes.CONVERSATION_SNOOZE_EXPIRED)).toHaveLength(0)
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

    it('leaves out a member who is suspended', async () => {
      const suspended = await suspendedAgent()
      const conversation = await mk()
      const message = await createMessage(owner, {
        storeId: ctx.storeA.id,
        conversationId: conversation.id
      })

      await app
        .get(EventEmitter2)
        .emitAsync(Events.MEDIA_INFECTED, infected(conversation.id, message.id))

      const told = (await rowsOf(NotificationTypes.MEDIA_INFECTED)).map(row => row.userId)
      expect(told).toContain(ctx.agentA.id)
      expect(told).not.toContain(suspended.id)
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

  describe('an unscannable file', () => {
    it('tells who may read the conversation, audits it, and tells each person once', async () => {
      const conversation = await mk()
      const message = await createMessage(owner, {
        storeId: ctx.storeA.id,
        conversationId: conversation.id
      })
      const events = app.get(EventEmitter2)
      const payload: MessageChangedPayload = {
        storeId: ctx.storeA.id,
        conversationId: conversation.id,
        messageId: message.id,
        internal: false,
        visibility: { hidden: false, assignedTo: null }
      }

      await events.emitAsync(Events.MEDIA_UNSCANNABLE, payload)
      await events.emitAsync(Events.MEDIA_UNSCANNABLE, payload)

      const rows = await rowsOf(NotificationTypes.MEDIA_UNSCANNABLE)
      const told = rows.map(row => row.userId)
      expect(told).toEqual(expect.arrayContaining([ctx.adminA.id, ctx.agentA.id]))
      expect(told).not.toContain(ctx.adminB.id)
      expect(new Set(told).size).toBe(told.length)
      expect(
        // The audit write is fire-and-forget: wait for both rows, not for the first one
        await waitForAuditEntries(
          owner,
          {
            storeId: ctx.storeA.id,
            action: AuditAction.MEDIA_UNSCANNABLE,
            resourceId: message.id
          },
          2
        )
      ).toHaveLength(2)
    })
  })

  describe('an export that settled', () => {
    const exportOf = (
      requestedBy: string,
      status: string,
      type: string = ExportTypes.CUSTOMERS,
      error: string | null = null
    ) =>
      owner.export.create({
        data: {
          storeId: ctx.storeA.id,
          requestedBy,
          type,
          format: ExportFormats.CSV,
          status,
          key: status === ExportStatus.READY ? `exports/${ctx.storeA.id}/x/customers.csv` : null,
          error,
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

    it('tells nobody when the one who asked for it is suspended', async () => {
      const suspended = await actorWithPermissions(owner, app, {
        prefix,
        name: `suspendedExport${randomUUID().slice(0, 6)}`,
        organizationId: ctx.orgA.id,
        storeId: ctx.storeA.id,
        permissions: [Permissions.CONVERSATIONS_VIEW, Permissions.CUSTOMERS_EXPORT]
      })
      const row = await exportOf(suspended.id, ExportStatus.READY)
      await owner.membership.updateMany({
        where: { userId: suspended.id, storeId: ctx.storeA.id },
        data: { status: MembershipStatus.SUSPENDED }
      })

      await app.get(EventEmitter2).emitAsync(Events.EXPORT_READY, settled(row))

      expect(await rowsOf(NotificationTypes.EXPORT_READY)).toHaveLength(0)
    })

    it('tells who asked for it that the export failed', async () => {
      const row = await exportOf(
        ctx.adminA.id,
        ExportStatus.FAILED,
        ExportTypes.CUSTOMERS,
        ErrorCodes.EXPORT_FAILED
      )

      await app.get(EventEmitter2).emitAsync(Events.EXPORT_FAILED, settled(row))

      const rows = await rowsOf(NotificationTypes.EXPORT_FAILED, ctx.adminA.id)
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ params: { type: ExportTypes.CUSTOMERS } })
      // The generic failure is what the worker writes when it has no better reason: no reason is carried
      expect(rows[0]?.params).not.toHaveProperty('reason')
    })

    it.each([ErrorCodes.EXPORT_TOO_LARGE, ErrorCodes.EXPORT_EMPTY])(
      'says why the export failed when the row holds %s (MED-11)',
      async code => {
        const row = await exportOf(ctx.adminA.id, ExportStatus.FAILED, ExportTypes.MEDIA_ZIP, code)

        await app.get(EventEmitter2).emitAsync(Events.EXPORT_FAILED, settled(row))

        const rows = (await rowsOf(NotificationTypes.EXPORT_FAILED, ctx.adminA.id)).filter(
          notification => notification.resourceId === row.id
        )
        expect(rows).toHaveLength(1)
        expect(rows[0]).toMatchObject({ params: { type: ExportTypes.MEDIA_ZIP, reason: code } })
      }
    )

    it('tells nobody when the row is not in the state of the event, is not theirs or is of a kind their role lost', async () => {
      const events = app.get(EventEmitter2)
      const pending = await exportOf(ctx.adminA.id, ExportStatus.PENDING)
      const ready = await exportOf(ctx.adminA.id, ExportStatus.READY)
      const lost = await exportOf(ctx.agentA.id, ExportStatus.READY)

      await events.emitAsync(Events.EXPORT_READY, settled(pending))
      await events.emitAsync(Events.EXPORT_READY, { ...settled(ready), requestedBy: ctx.agentA.id })
      await events.emitAsync(Events.EXPORT_READY, settled(lost))
      await events.emitAsync(Events.EXPORT_READY, {
        ...settled(ready),
        exportType: ExportTypes.AUDIT_LOG
      })

      expect(await rowsOf(NotificationTypes.EXPORT_READY)).toHaveLength(0)
    })
  })
})
