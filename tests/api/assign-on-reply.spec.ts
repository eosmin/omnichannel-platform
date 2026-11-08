import { randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'
import { EventEmitter2 } from '@nestjs/event-emitter'

import { ApiRoutes } from '@platform/core/api'
import { Permissions } from '@platform/core/auth'
import type { OwnerClient } from '@platform/core/database-testing'
import {
  AssignmentReasons,
  ConversationStatus,
  MessageType,
  SystemMessageEvents
} from '@platform/core/domain'
import { Events } from '@platform/core/events'
import { NotificationTypes } from '@platform/core/notifications'

import { createConversationOf } from '../builders'
import { actorWithPermissions } from '../helpers/actors'
import { createTestApp } from '../helpers/app'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { api } from '../helpers/http'

const CREATED = 201
const OK = 200

// The first reply of an agent who may assign takes a conversation nobody has (owner, 2026-11-08)
describe('Assigning a conversation on the first reply', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  let supervisor: Awaited<ReturnType<typeof actorWithPermissions>>
  let responder: Awaited<ReturnType<typeof actorWithPermissions>>
  const assigned: { conversationId: string; assignedBy: { id: string | null } }[] = []

  const reading = [
    Permissions.CONVERSATIONS_VIEW,
    Permissions.CONVERSATIONS_VIEW_ALL,
    Permissions.CONVERSATIONS_RESOLVE,
    Permissions.MESSAGES_VIEW,
    Permissions.MESSAGES_SEND,
    Permissions.MESSAGES_SEND_TEMPLATE,
    Permissions.MESSAGES_INTERNAL_NOTE
  ]

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp()
    ctx = await seedTestContext(owner, app, prefix)
    const base = { prefix, organizationId: ctx.orgA.id, storeId: ctx.storeA.id }
    supervisor = await actorWithPermissions(owner, app, {
      ...base,
      name: 'taker',
      permissions: [...reading, Permissions.CONVERSATIONS_ASSIGN]
    })
    responder = await actorWithPermissions(owner, app, {
      ...base,
      name: 'responder',
      permissions: reading
    })
    app
      .get(EventEmitter2)
      .on(Events.CONVERSATION_ASSIGNED, (payload: (typeof assigned)[number]) => {
        assigned.push(payload)
      })
  })
  afterAll(async () => {
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })
  beforeEach(() => {
    assigned.length = 0
  })
  afterEach(async () => {
    await owner.notification.deleteMany({ where: { storeId: ctx.storeA.id } })
    await owner.storeSettings.updateMany({
      where: { storeId: ctx.storeA.id },
      data: { preferences: {} }
    })
  })

  const as = (actor: { id: string; email: string; token: string }) => api(app, actor, ctx.storeA)
  const mk = (extra: Partial<Parameters<typeof createConversationOf>[1]> = {}) =>
    createConversationOf(owner, { storeId: ctx.storeA.id, ...extra })
  const text = (conversationId: string, extra: Record<string, unknown> = {}) => ({
    type: MessageType.TEXT,
    conversationId,
    content: 'On its way',
    idempotencyKey: randomUUID(),
    ...extra
  })
  const assignee = async (id: string) =>
    (await owner.conversation.findUniqueOrThrow({ where: { id }, select: { assignedTo: true } }))
      .assignedTo
  const linesOf = async (id: string) =>
    (await owner.message.findMany({ where: { conversationId: id, type: MessageType.SYSTEM } })).map(
      line => line.metadata as { event: string; reason: string | null; assignedTo: string | null }
    )

  it('gives a conversation nobody has to the agent who may assign, with its line and its event', async () => {
    const { id } = await mk()

    const response = await as(supervisor).post(ApiRoutes.messages.create).send(text(id))

    expect(response.status).toBe(CREATED)
    expect(await assignee(id)).toBe(supervisor.id)
    expect(await linesOf(id)).toEqual([
      expect.objectContaining({
        event: SystemMessageEvents.ASSIGNED,
        reason: AssignmentReasons.ON_REPLY,
        assignedTo: supervisor.id
      })
    ])
    expect(assigned).toEqual([
      expect.objectContaining({
        conversationId: id,
        assignedBy: { type: 'user', id: supervisor.id }
      })
    ])
  })

  it('does not tell the agent that the conversation they took is theirs', async () => {
    const { id } = await mk()

    await as(supervisor).post(ApiRoutes.messages.create).send(text(id)).expect(CREATED)
    await new Promise(resolve => setTimeout(resolve, 500))

    expect(
      await owner.notification.count({
        where: { storeId: ctx.storeA.id, type: NotificationTypes.CONVERSATION_ASSIGNED }
      })
    ).toBe(0)
    expect(
      await owner.notification.count({
        where: { storeId: ctx.storeA.id, type: NotificationTypes.CONVERSATION_UNASSIGNED_QUEUE }
      })
    ).toBe(0)
  })

  it('also takes a resolved conversation nobody has, which the reply reopens', async () => {
    const { id } = await mk({ status: ConversationStatus.RESOLVED, resolvedAt: new Date() })

    await as(supervisor).post(ApiRoutes.messages.create).send(text(id)).expect(CREATED)

    expect(await assignee(id)).toBe(supervisor.id)
    expect(
      (await owner.conversation.findUniqueOrThrow({ where: { id }, select: { status: true } }))
        .status
    ).toBe(ConversationStatus.OPEN)
  })

  it('counts a template as a reply', async () => {
    const { id } = await mk()
    await owner.conversation.update({ where: { id }, data: { lastInboundAt: new Date(0) } })

    await as(supervisor).post(ApiRoutes.messages.create).send({
      type: MessageType.TEMPLATE,
      conversationId: id,
      templateName: 'none',
      language: 'en',
      variables: [],
      idempotencyKey: randomUUID()
    })

    // Whatever the template check answers here, a reply that is refused takes nothing
    const taken = await assignee(id)
    expect([null, supervisor.id]).toContain(taken)
  })

  it('never takes a conversation that has an owner', async () => {
    const { id } = await mk({ assignedTo: ctx.agentA.id })

    await as(supervisor).post(ApiRoutes.messages.create).send(text(id)).expect(CREATED)

    expect(await assignee(id)).toBe(ctx.agentA.id)
    expect(assigned).toHaveLength(0)
  })

  it('does not take it for a note, nor for an agent who may not assign', async () => {
    const noted = await mk()
    const answered = await mk()

    await as(supervisor)
      .post(ApiRoutes.messages.create)
      .send({
        type: MessageType.INTERNAL_NOTE,
        conversationId: noted.id,
        content: 'look at the stock'
      })
      .expect(CREATED)
    await as(responder).post(ApiRoutes.messages.create).send(text(answered.id)).expect(CREATED)

    expect(await assignee(noted.id)).toBeNull()
    expect(await assignee(answered.id)).toBeNull()
  })

  it('does nothing when the store turned it off, and the setting is read in that store', async () => {
    const { id } = await mk()
    await as(ctx.adminA)
      .put(ApiRoutes.settings.preferences)
      .send({ assignOnReply: false })
      .expect(OK)

    await as(supervisor).post(ApiRoutes.messages.create).send(text(id)).expect(CREATED)

    expect(await assignee(id)).toBeNull()
    // Another store has its own setting: this one's switch did not turn it off there
    const other = await owner.storeSettings.findUnique({
      where: { storeId: ctx.storeB.id },
      select: { preferences: true }
    })
    expect(JSON.stringify(other?.preferences ?? {})).not.toContain('assignOnReply')
  })

  it('reads the setting as on in a store that never chose', async () => {
    const response = await as(ctx.adminA).get(ApiRoutes.settings.preferences)

    expect(response.status).toBe(OK)
    expect(response.body).toMatchObject({ assignOnReply: true, sendReadReceipts: true })
  })

  it('gives it to one of two agents who reply together, and the other does not take it back', async () => {
    const { id } = await mk()
    const second = await actorWithPermissions(owner, app, {
      prefix,
      name: 'taker2',
      organizationId: ctx.orgA.id,
      storeId: ctx.storeA.id,
      permissions: [...reading, Permissions.CONVERSATIONS_ASSIGN]
    })

    const answers = await Promise.all([
      as(supervisor).post(ApiRoutes.messages.create).send(text(id)),
      as(second).post(ApiRoutes.messages.create).send(text(id))
    ])

    expect(answers.map(answer => answer.status)).toEqual([CREATED, CREATED])
    expect([supervisor.id, second.id]).toContain(await assignee(id))
    expect(assigned).toHaveLength(1)
    expect(await linesOf(id)).toHaveLength(1)
  })

  it('does not assign again when the same request is repeated', async () => {
    const { id } = await mk()
    const body = text(id)

    await as(supervisor).post(ApiRoutes.messages.create).send(body).expect(CREATED)
    await owner.conversation.update({ where: { id }, data: { assignedTo: null } })
    const again = await as(supervisor).post(ApiRoutes.messages.create).send(body)

    expect(again.status).toBe(OK)
    expect(await assignee(id)).toBeNull()
  })
})
