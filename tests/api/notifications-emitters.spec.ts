import { randomUUID } from 'node:crypto'

import { getQueueToken } from '@nestjs/bullmq'
import type { INestApplication } from '@nestjs/common'
import { EventEmitter2 } from '@nestjs/event-emitter'

import { ApiRoutes } from '@platform/core/api'
import { Permissions, RoleNames } from '@platform/core/auth'
import type { OwnerClient } from '@platform/core/database-testing'
import {
  AppPaths,
  AuthorType,
  ChannelConnectionStatus,
  ChannelIds,
  ConversationStatus,
  ConversationStatusReasons,
  DeliveryStatus,
  MembershipStatus,
  StoreSettingsSections
} from '@platform/core/domain'
import { type ErrorCode, ErrorCodes } from '@platform/core/errors'
import { ChannelDisconnectedReasons, Events } from '@platform/core/events'
import { NotificationLimits, NotificationTypes } from '@platform/core/notifications'
import { JobNames, QueueNames } from '@platform/core/queues'

import { createChannelConnection, createConversationOf, createMessage } from '../builders'
import { actorWithPermissions } from '../helpers/actors'
import { createTestApp } from '../helpers/app'
import { createActor, seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { api } from '../helpers/http'
import { CapturedQueue } from '../helpers/queue'

const OK = 200
const POLL_MS = 100
const ATTEMPTS = 50
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

// The notifications of Step 3.5 that had no emitter until the QA fix Q2: the queue of the team, a
// reopening, a message that arrives, a reply that fails, a new member, a channel that goes down.
// The events are emitted by hand where the listener is what is tested, and through the api where the
// emitter is (a status change, an assignment to nobody).
describe('Notification emitters (QA Q2)', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  const pushQueue = new CapturedQueue()

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp([], builder =>
      builder.overrideProvider(getQueueToken(QueueNames.NOTIFICATIONS)).useValue(pushQueue)
    )
    ctx = await seedTestContext(owner, app, prefix)
  })
  afterAll(async () => {
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })
  afterEach(async () => {
    await owner.notification.deleteMany({ where: { storeId: ctx.storeA.id } })
    await owner.notificationPreference.deleteMany({ where: { storeId: ctx.storeA.id } })
    await owner.pushSubscription.deleteMany({
      where: { userId: { in: [ctx.adminA.id, ctx.agentA.id, ctx.viewerA.id] } }
    })
    pushQueue.jobs.length = 0
  })

  const emit = (event: string, payload: object) => app.get(EventEmitter2).emitAsync(event, payload)
  const rowsOf = (type: string, userId?: string) =>
    owner.notification.findMany({
      where: { storeId: ctx.storeA.id, type, ...(userId === undefined ? {} : { userId }) }
    })
  const idsOf = async (type: string) => (await rowsOf(type)).map(row => row.userId).sort()
  async function waitForRows(type: string, expected: number) {
    for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
      const rows = await rowsOf(type)
      if (rows.length >= expected) return rows
      await wait(POLL_MS)
    }
    return rowsOf(type)
  }
  async function settle(type: string) {
    await wait(POLL_MS * 5)
    return rowsOf(type)
  }
  const mk = (extra: Partial<Parameters<typeof createConversationOf>[1]> = {}) =>
    createConversationOf(owner, { storeId: ctx.storeA.id, ...extra })
  const system = { type: 'system', id: null } as const
  const sorted = (...ids: string[]) => [...ids].sort()

  describe('the queue of conversations nobody owns', () => {
    const unassigned = (conversationId: string, unassignedBy: object = system) => ({
      storeId: ctx.storeA.id,
      conversationId,
      unassignedBy
    })

    it('tells who can take it, with the path, and not who can only read', async () => {
      const { id } = await mk()

      await emit(Events.CONVERSATION_UNASSIGNED, unassigned(id))

      const rows = await rowsOf(NotificationTypes.CONVERSATION_UNASSIGNED_QUEUE)
      expect(rows.map(row => row.userId).sort()).toEqual(sorted(ctx.adminA.id, ctx.agentA.id))
      expect(rows[0]).toMatchObject({
        actionPath: AppPaths.store.conversation(ctx.storeA.id, id),
        resourceType: 'conversation',
        resourceId: id
      })
      expect(rows.map(row => row.userId)).not.toContain(ctx.viewerA.id)
    })

    it('names whose conversation it is, so a text and an email can tell two of them apart', async () => {
      const named = await mk()
      await owner.customer.update({
        where: { id: named.customerId },
        data: { name: 'Lucia Prechat' }
      })
      const anonymous = await mk()
      await owner.customer.update({ where: { id: anonymous.customerId }, data: { name: null } })
      await owner.customerIdentity.update({
        where: { id: anonymous.customerIdentityId },
        data: { displayName: null }
      })

      await emit(Events.CONVERSATION_UNASSIGNED, unassigned(named.id))
      await emit(Events.CONVERSATION_UNASSIGNED, unassigned(anonymous.id))

      const rows = await rowsOf(NotificationTypes.CONVERSATION_UNASSIGNED_QUEUE, ctx.agentA.id)
      const paramsOf = (conversationId: string) =>
        rows.find(row => row.resourceId === conversationId)?.params
      expect(paramsOf(named.id)).toEqual({ customer: 'Lucia Prechat' })
      // Without a name, the end of the handle, as a mention does
      expect(paramsOf(anonymous.id)).toEqual({
        customer: expect.stringMatching(/^····.{1,4}$/) as unknown
      })
    })

    it('leaves out the person who caused it', async () => {
      const { id } = await mk()

      await emit(
        Events.CONVERSATION_UNASSIGNED,
        unassigned(id, { type: 'user', id: ctx.adminA.id })
      )

      expect(await idsOf(NotificationTypes.CONVERSATION_UNASSIGNED_QUEUE)).toEqual([ctx.agentA.id])
    })

    it('tells each person once while they have not looked, and again after they did', async () => {
      const { id } = await mk()

      await emit(Events.CONVERSATION_UNASSIGNED, unassigned(id))
      await emit(Events.CONVERSATION_UNASSIGNED, unassigned(id))
      expect(await rowsOf(NotificationTypes.CONVERSATION_UNASSIGNED_QUEUE)).toHaveLength(2)

      await owner.notification.updateMany({
        where: { storeId: ctx.storeA.id, userId: ctx.agentA.id },
        data: { readAt: new Date() }
      })
      await emit(Events.CONVERSATION_UNASSIGNED, unassigned(id))

      expect(
        await rowsOf(NotificationTypes.CONVERSATION_UNASSIGNED_QUEUE, ctx.agentA.id)
      ).toHaveLength(2)
      expect(
        await rowsOf(NotificationTypes.CONVERSATION_UNASSIGNED_QUEUE, ctx.adminA.id)
      ).toHaveLength(1)
    })

    it('tells nobody when someone took it meanwhile, or it is not open, or it is hidden', async () => {
      const taken = await mk({ assignedTo: ctx.agentA.id })
      const snoozed = await mk({ status: ConversationStatus.SNOOZED })
      const archived = await mk({ status: ConversationStatus.ARCHIVED })

      await emit(Events.CONVERSATION_UNASSIGNED, unassigned(taken.id))
      await emit(Events.CONVERSATION_UNASSIGNED, unassigned(snoozed.id))
      await emit(Events.CONVERSATION_UNASSIGNED, unassigned(archived.id))

      expect(await rowsOf(NotificationTypes.CONVERSATION_UNASSIGNED_QUEUE)).toHaveLength(0)
    })

    it('does not tell a member who is suspended, nor one of another store', async () => {
      const suspended = await createActor(owner, app, {
        prefix,
        name: `suspendedQueue${randomUUID().slice(0, 6)}`,
        organizationId: ctx.orgA.id,
        storeId: ctx.storeA.id,
        roleId: ctx.roleIds[RoleNames.AGENT]
      })
      await owner.membership.updateMany({
        where: { userId: suspended.id, storeId: ctx.storeA.id },
        data: { status: MembershipStatus.SUSPENDED }
      })
      const { id } = await mk()

      await emit(Events.CONVERSATION_UNASSIGNED, unassigned(id))

      const told = await idsOf(NotificationTypes.CONVERSATION_UNASSIGNED_QUEUE)
      expect(told).not.toContain(suspended.id)
      expect(told).not.toContain(ctx.adminB.id)
    })

    it('is raised when a person gives a conversation up, and tells the others but not them', async () => {
      const { id } = await mk({ assignedTo: ctx.agentA.id })

      const response = await api(app, ctx.adminA, ctx.storeA)
        .patch(ApiRoutes.conversations.assign(id))
        .send({ userId: null })

      expect(response.status).toBe(OK)
      const rows = await waitForRows(NotificationTypes.CONVERSATION_UNASSIGNED_QUEUE, 1)
      expect(rows.map(row => row.userId)).toEqual([ctx.agentA.id])
    })

    it('tells the queue when a snooze ran out on a conversation nobody owns', async () => {
      const { id } = await mk({ status: ConversationStatus.OPEN })

      await emit(Events.CONVERSATION_SNOOZE_EXPIRED, {
        storeId: ctx.storeA.id,
        conversationId: id,
        assignedTo: null
      })

      expect(await idsOf(NotificationTypes.CONVERSATION_UNASSIGNED_QUEUE)).toEqual(
        sorted(ctx.adminA.id, ctx.agentA.id)
      )
      expect(await rowsOf(NotificationTypes.CONVERSATION_SNOOZE_EXPIRED)).toHaveLength(0)
    })
  })

  describe('a reopened conversation', () => {
    const reopened = (
      conversationId: string,
      assignedTo: string | null,
      reason: string | null,
      reopenedBy: object = { type: 'user', id: ctx.adminA.id }
    ) => ({ storeId: ctx.storeA.id, conversationId, assignedTo, reason, reopenedBy })

    it('is raised by the status change of a person, and tells the owner and not the person', async () => {
      const { id } = await mk({
        assignedTo: ctx.agentA.id,
        status: ConversationStatus.RESOLVED,
        resolvedAt: new Date()
      })

      const response = await api(app, ctx.adminA, ctx.storeA)
        .patch(ApiRoutes.conversations.status(id))
        .send({ status: ConversationStatus.OPEN })

      expect(response.status).toBe(OK)
      const rows = await waitForRows(NotificationTypes.CONVERSATION_REOPENED, 1)
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        userId: ctx.agentA.id,
        actionPath: AppPaths.store.conversation(ctx.storeA.id, id)
      })
    })

    it('does not tell a person who reopens their own conversation', async () => {
      const { id } = await mk({
        assignedTo: ctx.adminA.id,
        status: ConversationStatus.RESOLVED,
        resolvedAt: new Date()
      })

      const response = await api(app, ctx.adminA, ctx.storeA)
        .patch(ApiRoutes.conversations.status(id))
        .send({ status: ConversationStatus.OPEN })

      expect(response.status).toBe(OK)
      expect(await settle(NotificationTypes.CONVERSATION_REOPENED)).toHaveLength(0)
    })

    it('tells the owner when an agent reply or the owner phone reopened it', async () => {
      const { id } = await mk({ assignedTo: ctx.agentA.id })

      await emit(
        Events.CONVERSATION_REOPENED,
        reopened(id, ctx.agentA.id, ConversationStatusReasons.AGENT_REPLIED, {
          type: 'user',
          id: ctx.adminA.id
        })
      )

      expect(await idsOf(NotificationTypes.CONVERSATION_REOPENED)).toEqual([ctx.agentA.id])
    })

    it('leaves a reopening by the message of the customer to the message notification', async () => {
      const { id } = await mk({ assignedTo: ctx.agentA.id })

      await emit(
        Events.CONVERSATION_REOPENED,
        reopened(id, ctx.agentA.id, ConversationStatusReasons.CUSTOMER_REPLIED, system)
      )

      expect(await rowsOf(NotificationTypes.CONVERSATION_REOPENED)).toHaveLength(0)
      expect(await rowsOf(NotificationTypes.CONVERSATION_UNASSIGNED_QUEUE)).toHaveLength(0)
    })

    it('sends one nobody owns to the queue, not to a person', async () => {
      const { id } = await mk()

      await emit(Events.CONVERSATION_REOPENED, reopened(id, null, null))

      expect(await rowsOf(NotificationTypes.CONVERSATION_REOPENED)).toHaveLength(0)
      expect(await idsOf(NotificationTypes.CONVERSATION_UNASSIGNED_QUEUE)).toEqual([ctx.agentA.id])
    })

    it('does not send to the queue what a reply of the team reopened', async () => {
      const { id } = await mk()

      await emit(
        Events.CONVERSATION_REOPENED,
        reopened(id, null, ConversationStatusReasons.AGENT_REPLIED)
      )

      expect(await rowsOf(NotificationTypes.CONVERSATION_UNASSIGNED_QUEUE)).toHaveLength(0)
    })

    it('reads the owner from the row: one that changed hands is not told', async () => {
      const { id } = await mk({ assignedTo: ctx.adminA.id })

      await emit(
        Events.CONVERSATION_REOPENED,
        reopened(id, ctx.agentA.id, null, { type: 'user', id: ctx.viewerA.id })
      )

      expect(await rowsOf(NotificationTypes.CONVERSATION_REOPENED)).toHaveLength(0)
    })
  })

  describe('web push of a customer message (owner, 2026-11-08)', () => {
    const subscribe = (userId: string) =>
      owner.pushSubscription.create({
        data: {
          userId,
          endpoint: `https://fcm.googleapis.com/fcm/send/${randomUUID()}`,
          p256dh: 'k',
          auth: 'a'
        }
      })
    const pushedTo = (): string[] =>
      pushQueue.jobs
        .filter(job => job.name === JobNames.SEND_WEB_PUSH)
        .map(job => (job.data as { userId: string }).userId)
        .sort()
    const message = (conversationId: string, assignedTo: string | null) => ({
      storeId: ctx.storeA.id,
      conversationId,
      messageId: randomUUID(),
      customerId: randomUUID(),
      channelType: ChannelIds.INSTAGRAM,
      authorType: AuthorType.CUSTOMER,
      receivedAt: new Date().toISOString(),
      visibility: { hidden: false, assignedTo }
    })

    it('pushes to the owner of the conversation by default, once until they read it', async () => {
      const { id } = await mk({ assignedTo: ctx.agentA.id })
      await subscribe(ctx.agentA.id)

      await emit(Events.MESSAGE_RECEIVED, message(id, ctx.agentA.id))
      await emit(Events.MESSAGE_RECEIVED, message(id, ctx.agentA.id))

      expect(pushedTo()).toEqual([ctx.agentA.id])
    })

    it('does not push when the person turned the push of the type off', async () => {
      const { id } = await mk({ assignedTo: ctx.agentA.id })
      await subscribe(ctx.agentA.id)
      await owner.notificationPreference.create({
        data: {
          userId: ctx.agentA.id,
          storeId: ctx.storeA.id,
          type: NotificationTypes.MESSAGE_RECEIVED,
          inApp: true,
          push: false,
          email: false,
          sound: true
        }
      })

      await emit(Events.MESSAGE_RECEIVED, message(id, ctx.agentA.id))

      expect(await rowsOf(NotificationTypes.MESSAGE_RECEIVED)).toHaveLength(1)
      expect(pushedTo()).toEqual([])
    })

    it('pushes the queue to who can take the conversation, never to who can only read', async () => {
      const { id } = await mk()
      await subscribe(ctx.agentA.id)
      await subscribe(ctx.adminA.id)
      await subscribe(ctx.viewerA.id)

      await emit(Events.CONVERSATION_UNASSIGNED, {
        storeId: ctx.storeA.id,
        conversationId: id,
        unassignedBy: { type: 'system', id: null }
      })

      expect(pushedTo()).toEqual([ctx.adminA.id, ctx.agentA.id].sort())
      expect(pushedTo()).not.toContain(ctx.viewerA.id)
    })
  })

  describe('a message that arrives', () => {
    const received = (
      conversationId: string,
      overrides: { authorType?: string; assignedTo?: string | null } = {}
    ) => ({
      storeId: ctx.storeA.id,
      conversationId,
      messageId: randomUUID(),
      customerId: randomUUID(),
      channelType: ChannelIds.INSTAGRAM,
      authorType: overrides.authorType ?? AuthorType.CUSTOMER,
      contentPreview: 'hi',
      receivedAt: new Date().toISOString(),
      visibility: { hidden: false, assignedTo: overrides.assignedTo ?? null }
    })

    it('tells the owner of an open conversation, not the whole team', async () => {
      const { id } = await mk({ assignedTo: ctx.agentA.id })

      await emit(Events.MESSAGE_RECEIVED, received(id, { assignedTo: ctx.agentA.id }))

      const rows = await rowsOf(NotificationTypes.MESSAGE_RECEIVED)
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        userId: ctx.agentA.id,
        actionPath: AppPaths.store.conversation(ctx.storeA.id, id)
      })
    })

    it('tells once until they look: ten messages in a row are one line', async () => {
      const { id } = await mk({ assignedTo: ctx.agentA.id })

      // Together, as a burst arrives: the check and the write cannot all pass before the first lands
      await Promise.all(
        Array.from({ length: 10 }, () =>
          emit(Events.MESSAGE_RECEIVED, received(id, { assignedTo: ctx.agentA.id }))
        )
      )
      expect(await rowsOf(NotificationTypes.MESSAGE_RECEIVED)).toHaveLength(1)

      await owner.notification.updateMany({
        where: { storeId: ctx.storeA.id },
        data: { readAt: new Date() }
      })
      await emit(Events.MESSAGE_RECEIVED, received(id, { assignedTo: ctx.agentA.id }))

      expect(await rowsOf(NotificationTypes.MESSAGE_RECEIVED)).toHaveLength(2)
    })

    it('tells again when what they left unread is older than the window', async () => {
      const { id } = await mk({ assignedTo: ctx.agentA.id })
      await emit(Events.MESSAGE_RECEIVED, received(id, { assignedTo: ctx.agentA.id }))
      await owner.notification.updateMany({
        where: { storeId: ctx.storeA.id },
        data: { createdAt: new Date(Date.now() - 2 * NotificationLimits.DEDUP_WINDOW_MS) }
      })

      await emit(Events.MESSAGE_RECEIVED, received(id, { assignedTo: ctx.agentA.id }))

      expect(await rowsOf(NotificationTypes.MESSAGE_RECEIVED)).toHaveLength(2)
    })

    it('is a line for each conversation: another conversation is another news', async () => {
      const first = await mk({ assignedTo: ctx.agentA.id })
      const second = await mk({ assignedTo: ctx.agentA.id })

      await emit(Events.MESSAGE_RECEIVED, received(first.id, { assignedTo: ctx.agentA.id }))
      await emit(Events.MESSAGE_RECEIVED, received(second.id, { assignedTo: ctx.agentA.id }))

      expect(await rowsOf(NotificationTypes.MESSAGE_RECEIVED)).toHaveLength(2)
    })

    it('adds nothing to an assignment, a wake or a reopening they have not seen yet', async () => {
      const { id } = await mk({ assignedTo: ctx.agentA.id })
      await owner.notification.create({
        data: {
          userId: ctx.agentA.id,
          storeId: ctx.storeA.id,
          type: NotificationTypes.CONVERSATION_ASSIGNED,
          severity: 'info',
          messageKey: 'notifications.conversation.assigned',
          params: {},
          resourceType: 'conversation',
          resourceId: id
        }
      })

      await emit(Events.MESSAGE_RECEIVED, received(id, { assignedTo: ctx.agentA.id }))

      expect(await rowsOf(NotificationTypes.MESSAGE_RECEIVED)).toHaveLength(0)
    })

    it('tells nobody when nobody owns it: the queue has its own notification', async () => {
      const { id } = await mk()

      await emit(Events.MESSAGE_RECEIVED, received(id))

      expect(await rowsOf(NotificationTypes.MESSAGE_RECEIVED)).toHaveLength(0)
    })

    it('tells nobody of what the team itself wrote, nor of a conversation that is not open', async () => {
      const open = await mk({ assignedTo: ctx.agentA.id })
      const snoozed = await mk({ assignedTo: ctx.agentA.id, status: ConversationStatus.SNOOZED })

      await emit(
        Events.MESSAGE_RECEIVED,
        received(open.id, { authorType: AuthorType.EXTERNAL, assignedTo: ctx.agentA.id })
      )
      await emit(
        Events.MESSAGE_RECEIVED,
        received(open.id, { authorType: AuthorType.AGENT, assignedTo: ctx.agentA.id })
      )
      await emit(Events.MESSAGE_RECEIVED, received(snoozed.id, { assignedTo: ctx.agentA.id }))

      expect(await rowsOf(NotificationTypes.MESSAGE_RECEIVED)).toHaveLength(0)
    })

    it('does not tell an owner who cannot open it any more', async () => {
      const noView = await actorWithPermissions(owner, app, {
        prefix,
        name: `noView${randomUUID().slice(0, 6)}`,
        organizationId: ctx.orgA.id,
        storeId: ctx.storeA.id,
        permissions: [Permissions.CONVERSATIONS_VIEW]
      })
      const { id } = await mk({ assignedTo: noView.id })

      await emit(Events.MESSAGE_RECEIVED, received(id, { assignedTo: noView.id }))

      expect(await rowsOf(NotificationTypes.MESSAGE_RECEIVED)).toHaveLength(0)
    })
  })

  describe('a reply that failed', () => {
    async function failedReply(
      conversationId: string,
      author: { authorType: AuthorType; authorId?: string },
      deliveryStatus: string = DeliveryStatus.FAILED
    ) {
      const { id } = await createMessage(owner, {
        storeId: ctx.storeA.id,
        conversationId,
        authorType: author.authorType
      })
      await owner.message.update({
        where: { id },
        data: {
          deliveryStatus,
          deliveryError: ErrorCodes.CHANNEL_MESSAGE_FAILED,
          authorId: author.authorId ?? null
        }
      })
      return id
    }
    const failed = (
      conversationId: string,
      messageId: string,
      errorCode: ErrorCode = ErrorCodes.CHANNEL_MESSAGE_FAILED
    ) => ({
      storeId: ctx.storeA.id,
      conversationId,
      messageId,
      visibility: { hidden: false, assignedTo: null },
      errorCode
    })

    it('tells who wrote it, not the owner of the conversation, with its path', async () => {
      // The author (an Admin, who sees every conversation) and the owner are two people
      const { id } = await mk({ assignedTo: ctx.agentA.id })
      const messageId = await failedReply(id, {
        authorType: AuthorType.AGENT,
        authorId: ctx.adminA.id
      })

      await emit(Events.MESSAGE_FAILED, failed(id, messageId))

      const rows = await rowsOf(NotificationTypes.MESSAGE_FAILED)
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        userId: ctx.adminA.id,
        resourceType: 'message',
        resourceId: messageId,
        actionPath: AppPaths.store.conversation(ctx.storeA.id, id)
      })
    })

    it('carries why the channel refused the reply (NOT-06)', async () => {
      const { id } = await mk({ assignedTo: ctx.agentA.id })
      const messageId = await failedReply(id, {
        authorType: AuthorType.AGENT,
        authorId: ctx.adminA.id
      })

      await emit(Events.MESSAGE_FAILED, failed(id, messageId, ErrorCodes.CHANNEL_WINDOW_EXPIRED))

      const rows = await rowsOf(NotificationTypes.MESSAGE_FAILED)
      expect(rows[0]).toMatchObject({ params: { reason: ErrorCodes.CHANNEL_WINDOW_EXPIRED } })
    })

    it('tells the owner of the conversation when nobody on the team wrote the reply', async () => {
      const { id } = await mk({ assignedTo: ctx.agentA.id })
      const messageId = await failedReply(id, { authorType: AuthorType.SYSTEM })

      await emit(Events.MESSAGE_FAILED, failed(id, messageId))

      expect(await idsOf(NotificationTypes.MESSAGE_FAILED)).toEqual([ctx.agentA.id])
    })

    it('tells nobody when no one wrote it and nobody owns the conversation', async () => {
      const { id } = await mk()
      const messageId = await failedReply(id, { authorType: AuthorType.SYSTEM })

      await emit(Events.MESSAGE_FAILED, failed(id, messageId))

      expect(await rowsOf(NotificationTypes.MESSAGE_FAILED)).toHaveLength(0)
    })

    it('tells nobody when the reply went out on the second try, or is not a reply', async () => {
      const { id } = await mk({ assignedTo: ctx.agentA.id })
      const sent = await failedReply(
        id,
        { authorType: AuthorType.AGENT, authorId: ctx.agentA.id },
        DeliveryStatus.SENT
      )

      await emit(Events.MESSAGE_FAILED, failed(id, sent))
      await emit(Events.MESSAGE_FAILED, failed(id, randomUUID()))

      expect(await rowsOf(NotificationTypes.MESSAGE_FAILED)).toHaveLength(0)
    })

    it('does not look into a message of another conversation of the store', async () => {
      const mine = await mk({ assignedTo: ctx.agentA.id })
      const other = await mk({ assignedTo: ctx.adminA.id })
      const messageId = await failedReply(other.id, {
        authorType: AuthorType.AGENT,
        authorId: ctx.adminA.id
      })

      await emit(Events.MESSAGE_FAILED, failed(mine.id, messageId))

      expect(await rowsOf(NotificationTypes.MESSAGE_FAILED)).toHaveLength(0)
    })

    it('tells a failure of the same message once until they look', async () => {
      const { id } = await mk({ assignedTo: ctx.agentA.id })
      const messageId = await failedReply(id, {
        authorType: AuthorType.AGENT,
        authorId: ctx.agentA.id
      })

      await emit(Events.MESSAGE_FAILED, failed(id, messageId))
      await emit(Events.MESSAGE_FAILED, failed(id, messageId))

      expect(await rowsOf(NotificationTypes.MESSAGE_FAILED)).toHaveLength(1)
    })
  })

  describe('a new member', () => {
    let joiner: { id: string }
    let inviter: { id: string }
    let manager: { id: string }

    beforeAll(async () => {
      const make = (name: string, permissions: string[]) =>
        actorWithPermissions(owner, app, {
          prefix,
          name,
          organizationId: ctx.orgA.id,
          storeId: ctx.storeA.id,
          permissions: permissions as never
        })
      joiner = await make('joinerNotified', [Permissions.CONVERSATIONS_VIEW])
      inviter = await make('inviterNotified', [Permissions.TEAM_INVITE])
      manager = await make('managerNotified', [Permissions.TEAM_INVITE])
    })
    const joined = (userId: string, invitedBy: string) => ({
      storeId: ctx.storeA.id,
      userId,
      invitedBy
    })

    it('tells who invited that it was accepted, and who runs the team that someone joined', async () => {
      await emit(Events.MEMBER_JOINED, joined(joiner.id, inviter.id))

      const accepted = await rowsOf(NotificationTypes.INVITATION_ACCEPTED)
      expect(accepted.map(row => row.userId)).toEqual([inviter.id])
      expect(accepted[0]).toMatchObject({
        actionPath: AppPaths.store.settings(ctx.storeA.id, StoreSettingsSections.TEAM),
        resourceId: joiner.id
      })
      const members = await idsOf(NotificationTypes.MEMBER_JOINED)
      expect(members).toContain(manager.id)
      // Nobody is told twice, and nobody about themselves
      expect(members).not.toContain(inviter.id)
      expect(members).not.toContain(joiner.id)
      // Who cannot invite is not the roster's business
      expect(members).not.toContain(ctx.viewerA.id)
      expect(members).not.toContain(ctx.adminB.id)
    })

    it('does not tell a member whose access was revoked', async () => {
      const revoked = await actorWithPermissions(owner, app, {
        prefix,
        name: `revokedNotified${randomUUID().slice(0, 6)}`,
        organizationId: ctx.orgA.id,
        storeId: ctx.storeA.id,
        permissions: [Permissions.TEAM_INVITE]
      })
      await owner.membership.updateMany({
        where: { userId: revoked.id, storeId: ctx.storeA.id },
        data: { revokedAt: new Date() }
      })

      await emit(Events.MEMBER_JOINED, joined(joiner.id, inviter.id))

      expect(await idsOf(NotificationTypes.MEMBER_JOINED)).not.toContain(revoked.id)
    })

    it('tells nobody when the member is not active any more, nor the inviter who left', async () => {
      const gone = await actorWithPermissions(owner, app, {
        prefix,
        name: `goneNotified${randomUUID().slice(0, 6)}`,
        organizationId: ctx.orgA.id,
        storeId: ctx.storeA.id,
        permissions: [Permissions.TEAM_INVITE]
      })
      await owner.membership.updateMany({
        where: { userId: gone.id, storeId: ctx.storeA.id },
        data: { status: MembershipStatus.SUSPENDED }
      })

      await emit(Events.MEMBER_JOINED, joined(gone.id, inviter.id))
      expect(await rowsOf(NotificationTypes.INVITATION_ACCEPTED)).toHaveLength(0)
      expect(await rowsOf(NotificationTypes.MEMBER_JOINED)).toHaveLength(0)

      await emit(Events.MEMBER_JOINED, joined(joiner.id, gone.id))
      expect(await rowsOf(NotificationTypes.INVITATION_ACCEPTED)).toHaveLength(0)
    })
  })

  describe('a channel that went down', () => {
    async function connection(status: string) {
      const { id } = await createChannelConnection(owner, {
        storeId: ctx.storeA.id,
        channelType: ChannelIds.INSTAGRAM
      })
      await owner.channelConnection.update({ where: { id }, data: { status } })
      return id
    }
    const down = (
      channelConnectionId: string,
      reason: string = ChannelDisconnectedReasons.ERROR
    ) => ({
      storeId: ctx.storeA.id,
      channelConnectionId,
      pluginId: ChannelIds.INSTAGRAM,
      reason
    })

    it('tells who can set it up again, with the path of the channels page, once', async () => {
      const id = await connection(ChannelConnectionStatus.ERROR)

      await emit(Events.CHANNEL_DISCONNECTED, down(id))
      await emit(Events.CHANNEL_DISCONNECTED, down(id))

      const rows = await rowsOf(NotificationTypes.CHANNEL_DISCONNECTED)
      // The admin holds the settings permission; an agent and a viewer do not
      expect(rows.map(row => row.userId)).toContain(ctx.adminA.id)
      expect(rows.map(row => row.userId)).not.toContain(ctx.agentA.id)
      expect(rows.map(row => row.userId)).not.toContain(ctx.viewerA.id)
      expect(new Set(rows.map(row => row.userId)).size).toBe(rows.length)
      expect(rows[0]).toMatchObject({
        resourceType: 'channel_connection',
        resourceId: id,
        actionPath: AppPaths.store.settings(ctx.storeA.id, StoreSettingsSections.CHANNELS)
      })
    })

    it('tells nobody when a person disconnected it', async () => {
      const id = await connection(ChannelConnectionStatus.DISCONNECTED)

      await emit(Events.CHANNEL_DISCONNECTED, down(id, ChannelDisconnectedReasons.USER))

      expect(await rowsOf(NotificationTypes.CHANNEL_DISCONNECTED)).toHaveLength(0)
    })

    it('tells nobody of a disconnect by a person even if the row reads as an error', async () => {
      const id = await connection(ChannelConnectionStatus.ERROR)

      await emit(Events.CHANNEL_DISCONNECTED, down(id, ChannelDisconnectedReasons.USER))

      expect(await rowsOf(NotificationTypes.CHANNEL_DISCONNECTED)).toHaveLength(0)
    })

    it('tells nobody when it works again by the time the event is heard', async () => {
      const id = await connection(ChannelConnectionStatus.ACTIVE)

      await emit(Events.CHANNEL_DISCONNECTED, down(id))

      expect(await rowsOf(NotificationTypes.CHANNEL_DISCONNECTED)).toHaveLength(0)
    })

    it('does not tell for a connection of another store', async () => {
      const { id } = await createChannelConnection(owner, {
        storeId: ctx.storeB.id,
        channelType: ChannelIds.INSTAGRAM
      })
      await owner.channelConnection.update({
        where: { id },
        data: { status: ChannelConnectionStatus.ERROR }
      })

      await emit(Events.CHANNEL_DISCONNECTED, down(id))

      expect(await rowsOf(NotificationTypes.CHANNEL_DISCONNECTED)).toHaveLength(0)
    })
  })

  describe('a channel token that is about to expire', () => {
    const expiring = (channelConnectionId: string, storeId = ctx.storeA.id) => ({
      storeId,
      channelConnectionId,
      pluginId: ChannelIds.INSTAGRAM,
      expiresAt: '2026-11-14T10:00:00.000Z'
    })
    const connectionIn = async (storeId: string, status: string) => {
      const { id } = await createChannelConnection(owner, {
        storeId,
        channelType: ChannelIds.INSTAGRAM
      })
      await owner.channelConnection.update({ where: { id }, data: { status } })
      return id
    }

    it('tells who can set the channel up, with the day it stops and the path of the channels page', async () => {
      const id = await connectionIn(ctx.storeA.id, ChannelConnectionStatus.ACTIVE)

      await emit(Events.CHANNEL_TOKEN_EXPIRING, expiring(id))

      const rows = await rowsOf(NotificationTypes.CHANNEL_TOKEN_EXPIRING)
      expect(rows.map(row => row.userId)).toContain(ctx.adminA.id)
      expect(rows.map(row => row.userId)).not.toContain(ctx.agentA.id)
      expect(rows.map(row => row.userId)).not.toContain(ctx.viewerA.id)
      expect(rows[0]).toMatchObject({
        resourceType: 'channel_connection',
        resourceId: id,
        params: { date: '2026-11-14' },
        actionPath: AppPaths.store.settings(ctx.storeA.id, StoreSettingsSections.CHANNELS)
      })
    })

    it('tells nobody when the connection is already down: its own notice has been sent', async () => {
      const id = await connectionIn(ctx.storeA.id, ChannelConnectionStatus.ERROR)

      await emit(Events.CHANNEL_TOKEN_EXPIRING, expiring(id))

      expect(await rowsOf(NotificationTypes.CHANNEL_TOKEN_EXPIRING)).toHaveLength(0)
    })

    it('tells nobody of a store when the event names it for a connection that is another one’s', async () => {
      const id = await connectionIn(ctx.storeB.id, ChannelConnectionStatus.ACTIVE)

      await emit(Events.CHANNEL_TOKEN_EXPIRING, expiring(id, ctx.storeA.id))

      expect(await rowsOf(NotificationTypes.CHANNEL_TOKEN_EXPIRING)).toHaveLength(0)
    })
  })
})
