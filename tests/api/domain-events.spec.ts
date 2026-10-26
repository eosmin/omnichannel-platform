import { randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'
import { EventEmitter2 } from '@nestjs/event-emitter'

import { ApiRoutes } from '@platform/core/api'
import { RoleNames } from '@platform/core/auth'
import type { OwnerClient } from '@platform/core/database-testing'
import { ChannelType, ConversationStatus, MessageType } from '@platform/core/domain'
import { Events } from '@platform/core/events'

import { createConversationOf } from '../builders'
import { createTestApp } from '../helpers/app'
import { createActor, seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { api } from '../helpers/http'

interface Heard {
  event: string
  payload: Record<string, unknown>
}

// Any date: it is the moment of the request, which a test cannot know
const anyDate = expect.any(String) as string
const OK = 200
const CREATED = 201
const BAD_REQUEST = 400

describe('The domain events of the services', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  let agent2: { id: string; email: string; token: string }
  let heard: Heard[] = []

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp()
    ctx = await seedTestContext(owner, app, prefix)
    agent2 = await createActor(owner, app, {
      prefix,
      name: 'agent2A',
      organizationId: ctx.orgA.id,
      storeId: ctx.storeA.id,
      roleId: ctx.roleIds[RoleNames.AGENT]
    })
    app.get(EventEmitter2).onAny((event, payload) => {
      heard.push({ event: String(event), payload: payload as Record<string, unknown> })
    })
  })
  afterAll(async () => {
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })
  beforeEach(() => {
    heard = []
  })

  const asAdmin = () => api(app, ctx.adminA, ctx.storeA)
  const asAgent = () => api(app, ctx.agentA, ctx.storeA)
  const mk = () => createConversationOf(owner, { storeId: ctx.storeA.id })
  const heardOf = (event: string) => heard.filter(item => item.event === event)

  describe('of conversations', () => {
    it('announces a change of status with who made it, after it is stored', async () => {
      const { id } = await mk()

      await asAgent()
        .patch(ApiRoutes.conversations.status(id))
        .send({ status: ConversationStatus.RESOLVED })
        .expect(OK)

      expect(heardOf(Events.CONVERSATION_STATUS_CHANGED)).toEqual([
        {
          event: Events.CONVERSATION_STATUS_CHANGED,
          payload: {
            storeId: ctx.storeA.id,
            conversationId: id,
            previousStatus: ConversationStatus.OPEN,
            status: ConversationStatus.RESOLVED,
            assignedTo: null,
            changedBy: { type: 'user', id: ctx.agentA.id }
          }
        }
      ])
    })

    it('announces nothing for a change that is refused', async () => {
      const { id } = await mk()
      await asAgent()
        .patch(ApiRoutes.conversations.status(id))
        .send({ status: ConversationStatus.RESOLVED })
        .expect(OK)
      heard = []

      const again = await asAgent()
        .patch(ApiRoutes.conversations.status(id))
        .send({ status: ConversationStatus.RESOLVED })

      expect(again.status).not.toBe(OK)
      expect(heard).toEqual([])
    })

    it('announces an assignment with the previous assignee, and a release', async () => {
      const { id } = await mk()

      await asAdmin()
        .patch(ApiRoutes.conversations.assign(id))
        .send({ userId: ctx.agentA.id })
        .expect(OK)
      await asAdmin()
        .patch(ApiRoutes.conversations.assign(id))
        .send({ userId: agent2.id })
        .expect(OK)
      await asAdmin().patch(ApiRoutes.conversations.assign(id)).send({ userId: null }).expect(OK)

      expect(heardOf(Events.CONVERSATION_ASSIGNED).map(item => item.payload)).toEqual([
        {
          storeId: ctx.storeA.id,
          conversationId: id,
          assignedTo: ctx.agentA.id,
          previousAssignee: null,
          assignedBy: { type: 'user', id: ctx.adminA.id },
          visibility: { hidden: false, assignedTo: ctx.agentA.id }
        },
        {
          storeId: ctx.storeA.id,
          conversationId: id,
          assignedTo: agent2.id,
          previousAssignee: ctx.agentA.id,
          assignedBy: { type: 'user', id: ctx.adminA.id },
          visibility: { hidden: false, assignedTo: agent2.id }
        },
        {
          storeId: ctx.storeA.id,
          conversationId: id,
          assignedTo: null,
          previousAssignee: agent2.id,
          assignedBy: { type: 'user', id: ctx.adminA.id },
          visibility: { hidden: false, assignedTo: null }
        }
      ])
    })

    it('does not announce an assignment that changes nothing', async () => {
      const { id } = await mk()
      await asAdmin()
        .patch(ApiRoutes.conversations.assign(id))
        .send({ userId: ctx.agentA.id })
        .expect(OK)
      heard = []

      await asAdmin()
        .patch(ApiRoutes.conversations.assign(id))
        .send({ userId: ctx.agentA.id })
        .expect(OK)

      expect(heard).toEqual([])
    })

    it('announces that a conversation was read, and by whom', async () => {
      const { id } = await mk()

      await asAgent().post(ApiRoutes.conversations.read(id)).expect(OK)

      expect(heardOf(Events.CONVERSATION_READ).map(item => item.payload)).toEqual([
        {
          storeId: ctx.storeA.id,
          conversationId: id,
          userId: ctx.agentA.id,
          visibility: { hidden: false, assignedTo: null }
        }
      ])
    })
  })

  describe('of messages', () => {
    it('announces a reply by its ids, and the reopening it causes', async () => {
      const idempotencyKey = randomUUID()
      const { id } = await createConversationOf(owner, {
        storeId: ctx.storeA.id,
        status: ConversationStatus.RESOLVED
      })

      const sent = await asAgent()
        .post(ApiRoutes.messages.create)
        .send({
          type: MessageType.TEXT,
          conversationId: id,
          content: 'On its way',
          idempotencyKey
        })
        .expect(CREATED)

      const messageId = (sent.body as { id: string }).id
      const queued = heardOf(Events.MESSAGE_QUEUED)
      // Ids and dates only: no text, no idempotency key, and the reopened conversation is not hidden
      expect(queued.map(item => item.payload)).toEqual([
        {
          storeId: ctx.storeA.id,
          conversationId: id,
          messageId,
          authorId: ctx.agentA.id,
          createdAt: anyDate,
          visibility: { hidden: false, assignedTo: null }
        }
      ])
      expect(JSON.stringify(heard)).not.toContain('On its way')
      expect(JSON.stringify(heard)).not.toContain(idempotencyKey)
      expect(heardOf(Events.MESSAGE_NOTE_ADDED)).toEqual([])
      expect(heardOf(Events.CONVERSATION_STATUS_CHANGED).map(item => item.payload)).toEqual([
        {
          storeId: ctx.storeA.id,
          conversationId: id,
          previousStatus: ConversationStatus.RESOLVED,
          status: ConversationStatus.OPEN,
          assignedTo: null,
          changedBy: { type: 'user', id: ctx.agentA.id }
        }
      ])
    })

    it('announces a replay of the same key once only', async () => {
      const { id } = await mk()
      const body = {
        type: MessageType.TEXT,
        conversationId: id,
        content: 'Once',
        idempotencyKey: randomUUID()
      }

      await asAgent().post(ApiRoutes.messages.create).send(body).expect(CREATED)
      await asAgent().post(ApiRoutes.messages.create).send(body).expect(OK)

      expect(heardOf(Events.MESSAGE_QUEUED)).toHaveLength(1)
    })

    it('announces a note without its text, and one mention for each person named', async () => {
      const { id } = await mk()

      const sent = await asAdmin()
        .post(ApiRoutes.messages.create)
        .send({
          type: MessageType.INTERNAL_NOTE,
          conversationId: id,
          content: 'Secret price',
          mentions: [ctx.agentA.id, agent2.id]
        })
        .expect(CREATED)

      const messageId = (sent.body as { id: string }).id
      expect(heardOf(Events.MESSAGE_QUEUED)).toEqual([])
      const added = heardOf(Events.MESSAGE_NOTE_ADDED)
      expect(added.map(item => item.payload)).toEqual([
        {
          storeId: ctx.storeA.id,
          conversationId: id,
          messageId,
          authorId: ctx.adminA.id,
          createdAt: anyDate,
          visibility: { hidden: false, assignedTo: null }
        }
      ])
      expect(JSON.stringify(heard)).not.toContain('Secret price')
      expect(
        heardOf(Events.MESSAGE_MENTION)
          .map(item => item.payload.mentionedUserId)
          .sort()
      ).toEqual([ctx.agentA.id, agent2.id].sort())
    })

    it('says who may see the conversation, so that the event is not heard by anyone else', async () => {
      const assigned = await createConversationOf(owner, {
        storeId: ctx.storeA.id,
        assignedTo: ctx.agentA.id
      })
      const spam = await createConversationOf(owner, {
        storeId: ctx.storeA.id,
        status: ConversationStatus.SPAM
      })
      const note = (conversationId: string) =>
        asAdmin()
          .post(ApiRoutes.messages.create)
          .send({ type: MessageType.INTERNAL_NOTE, conversationId, content: 'x' })
          .expect(CREATED)

      await note(assigned.id)
      await note(spam.id)

      expect(
        heardOf(Events.MESSAGE_NOTE_ADDED).map(item => [
          item.payload.conversationId,
          item.payload.visibility
        ])
      ).toEqual([
        [assigned.id, { hidden: false, assignedTo: ctx.agentA.id }],
        [spam.id, { hidden: true, assignedTo: null }]
      ])
    })

    it('keeps a hidden conversation hidden, and shows an archived one that a reply reopens', async () => {
      const spam = await createConversationOf(owner, {
        storeId: ctx.storeA.id,
        status: ConversationStatus.SPAM,
        assignedTo: ctx.agentA.id
      })
      const archived = await createConversationOf(owner, {
        storeId: ctx.storeA.id,
        status: ConversationStatus.ARCHIVED
      })

      await asAdmin().post(ApiRoutes.conversations.read(spam.id)).expect(OK)
      await asAdmin()
        .patch(ApiRoutes.conversations.assign(spam.id))
        .send({ userId: null })
        .expect(OK)
      await asAdmin()
        .post(ApiRoutes.messages.create)
        .send({
          type: MessageType.TEXT,
          conversationId: archived.id,
          content: 'Back',
          idempotencyKey: randomUUID()
        })
        .expect(CREATED)

      expect(heardOf(Events.CONVERSATION_READ).map(item => item.payload.visibility)).toEqual([
        { hidden: true, assignedTo: ctx.agentA.id }
      ])
      expect(heardOf(Events.CONVERSATION_ASSIGNED).map(item => item.payload.visibility)).toEqual([
        { hidden: true, assignedTo: null }
      ])
      expect(heardOf(Events.MESSAGE_QUEUED).map(item => item.payload.visibility)).toEqual([
        { hidden: false, assignedTo: null }
      ])
    })

    it('does not announce a mention of the author by themselves', async () => {
      const { id } = await mk()

      await asAdmin()
        .post(ApiRoutes.messages.create)
        .send({
          type: MessageType.INTERNAL_NOTE,
          conversationId: id,
          content: 'Note to self',
          mentions: [ctx.adminA.id, agent2.id]
        })
        .expect(CREATED)

      expect(heardOf(Events.MESSAGE_MENTION).map(item => item.payload.mentionedUserId)).toEqual([
        agent2.id
      ])
    })

    it('announces nothing when the person mentioned cannot read notes', async () => {
      const { id } = await mk()

      const refused = await asAdmin()
        .post(ApiRoutes.messages.create)
        .send({
          type: MessageType.INTERNAL_NOTE,
          conversationId: id,
          content: 'For the viewer',
          mentions: [ctx.viewerA.id]
        })

      expect(refused.status).toBe(BAD_REQUEST)
      expect(heard).toEqual([])
    })

    it('announces nothing for a message that is refused', async () => {
      const { id } = await mk()

      const refused = await asAgent()
        .post(ApiRoutes.messages.create)
        .send({
          type: MessageType.INTERNAL_NOTE,
          conversationId: id,
          content: 'x',
          mentions: [randomUUID()]
        })

      expect(refused.status).toBe(BAD_REQUEST)
      expect(heard).toEqual([])
    })
  })

  describe('of customers', () => {
    const create = async (name: string) =>
      (await asAdmin().post(ApiRoutes.customers.list).send({ name }).expect(CREATED)).body as {
        id: string
      }

    it('announces a customer that is created and one that is updated', async () => {
      const ana = await create('Ana E')
      await asAdmin().patch(ApiRoutes.customers.byId(ana.id)).send({ name: 'Ana F' }).expect(OK)

      expect(heard.map(item => item.event)).toEqual([
        Events.CUSTOMER_CREATED,
        Events.CUSTOMER_UPDATED
      ])
      expect(heard[0]?.payload).toEqual({ storeId: ctx.storeA.id, customerId: ana.id })
    })

    it('does not announce an update that writes what the customer already had', async () => {
      const ana = await create('Ana J')
      heard = []

      await asAdmin().patch(ApiRoutes.customers.byId(ana.id)).send({ name: 'Ana J' }).expect(OK)
      await asAdmin().patch(ApiRoutes.customers.byId(ana.id)).send({ name: 'Ana K' }).expect(OK)

      expect(heard.map(item => item.event)).toEqual([Events.CUSTOMER_UPDATED])
    })

    it('announces a handle that is linked, and not one that was already there', async () => {
      const ana = await create('Ana G')
      heard = []
      const link = () =>
        asAdmin()
          .post(ApiRoutes.customers.identities(ana.id))
          .send({ channelType: ChannelType.WHATSAPP, channelIdentity: '7444-0001' })

      const first = await link()
      const again = await link()

      expect(first.status).toBe(CREATED)
      expect(again.status).toBeLessThan(BAD_REQUEST)
      // The handle itself is a phone number: the event names the identity, not what it holds
      expect(heardOf(Events.CUSTOMER_IDENTITY_LINKED).map(item => item.payload)).toEqual([
        {
          storeId: ctx.storeA.id,
          customerId: ana.id,
          identityId: (first.body as { id: string }).id,
          channelType: ChannelType.WHATSAPP
        }
      ])
      expect(JSON.stringify(heard)).not.toContain('7444')
    })

    it('announces a merge and the undoing of it', async () => {
      const survivor = await create('Ana H')
      const absorbed = await create('Ana I')
      heard = []

      await asAdmin()
        .post(ApiRoutes.customers.merge(survivor.id))
        .send({ absorbedId: absorbed.id, fieldChoices: {} })
        .expect(OK)
      const merge = await owner.customerMerge.findFirstOrThrow({
        where: { survivorId: survivor.id }
      })
      await asAdmin()
        .post(ApiRoutes.customers.unmerge(survivor.id))
        .send({ mergeId: merge.id })
        .expect(OK)

      const expected = {
        storeId: ctx.storeA.id,
        survivorId: survivor.id,
        absorbedId: absorbed.id
      }
      expect(heard).toEqual([
        { event: Events.CUSTOMER_MERGED, payload: expected },
        { event: Events.CUSTOMER_UNMERGED, payload: expected }
      ])
    })
  })

  it('does not fail a request because a listener fails', async () => {
    const emitter = app.get(EventEmitter2)
    const failing = (): never => {
      throw new Error('a listener that fails')
    }
    emitter.on(Events.CONVERSATION_READ, failing)
    try {
      const { id } = await mk()

      await asAgent().post(ApiRoutes.conversations.read(id)).expect(OK)

      expect((await owner.conversation.findUniqueOrThrow({ where: { id } })).lastReadBy).toBe(
        ctx.agentA.id
      )
    } finally {
      emitter.off(Events.CONVERSATION_READ, failing)
    }
  })
})
