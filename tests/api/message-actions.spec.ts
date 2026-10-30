import { randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import { Permissions } from '@platform/core/auth'
import { CredentialCipher } from '@platform/core/crypto'
import type { OwnerClient } from '@platform/core/database-testing'
import {
  AuthorType,
  ConversationStatus,
  DeliveryStatus,
  MessageLimits,
  MessageType
} from '@platform/core/domain'
import { ErrorCodes } from '@platform/core/errors'
import { QueueNames } from '@platform/core/queues'
import { PluginRegistry } from '@platform/plugins/runtime'
import { ChannelCapability, type MessageTemplate } from '@platform/plugins/sdk'

import {
  buildChannelPlugin,
  createChannelConnection,
  createConversation,
  createCustomerIdentity,
  createMessage
} from '../builders'
import { actorWithPermissions } from '../helpers/actors'
import { createTestApp } from '../helpers/app'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { api } from '../helpers/http'
import { queueOf } from '../helpers/queue'

interface ErrorBody {
  error: { code: string }
}
interface MessageBody {
  id: string
  type: string
  content: string | null
  deliveryStatus: string | null
  deliveryError: string | null
  replyTo: {
    id: string
    type: string
    authorType: string
    content: string | null
    deleted: boolean
  } | null
}
interface ThreadBody {
  data: MessageBody[]
}

const OK = 200
const CREATED = 201
const BAD_REQUEST = 400
const FORBIDDEN = 403
const NOT_FOUND = 404
const CONFLICT = 409
const INTERNAL_SERVER_ERROR = 500

const TEMPLATE_CHANNEL = 'template_test_channel'
const PLAIN_CHANNEL = 'plain_test_channel'
const DAY_MS = 86_400_000
const BODY = 'Hello {{1}}, your order {{2}} is ready'

describe('What an agent does with a message', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  let templates: () => Promise<MessageTemplate[]>
  let listed = 0

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp()
    ctx = await seedTestContext(owner, app, prefix)
    const registry = app.get(PluginRegistry, { strict: false })
    registry.register(
      buildChannelPlugin({
        id: TEMPLATE_CHANNEL,
        capabilities: [
          ChannelCapability.TEXT,
          ChannelCapability.MESSAGING_WINDOW,
          ChannelCapability.TEMPLATES
        ],
        messagingWindow: { hours: 24, requiresTemplateWhenClosed: true },
        listTemplates: () => {
          listed += 1
          return templates()
        },
        sendTemplate: () => Promise.reject(new Error('the worker sends, not the api'))
      })
    )
    registry.register(buildChannelPlugin({ id: PLAIN_CHANNEL }))
  })
  afterAll(async () => {
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })
  beforeEach(() => {
    listed = 0
    queueOf(app, QueueNames.OUTBOUND).jobs.length = 0
    templates = () =>
      Promise.resolve([
        { name: 'order_ready', language: 'es', status: 'approved', body: BODY },
        { name: 'promo', language: 'es', status: 'pending', body: 'Sale' }
      ])
  })

  const asAgent = () => api(app, ctx.agentA, ctx.storeA)
  const asAdmin = () => api(app, ctx.adminA, ctx.storeA)
  const asViewer = () => api(app, ctx.viewerA, ctx.storeA)
  const codeOf = (body: unknown) => (body as ErrorBody).error.code
  const message = (id: string) => owner.message.findUniqueOrThrow({ where: { id } })

  // The real cipher, because the api reads the credentials of the connection to list the templates
  const sealed = () => app.get(CredentialCipher, { strict: false }).seal({ token: 'dummy' })

  // A conversation over a connection of the given channel, in a store; the window is closed unless
  // the customer wrote a moment ago
  const conversationOn = async (
    channelType: string,
    over: { storeId?: string; windowOpen?: boolean; status?: ConversationStatus } = {}
  ) => {
    const storeId = over.storeId ?? ctx.storeA.id
    const identity = await createCustomerIdentity(owner, {
      storeId,
      channelType,
      lastInboundAt: new Date(Date.now() - (over.windowOpen === true ? 0 : 3 * DAY_MS))
    })
    const connection = await createChannelConnection(owner, { storeId, channelType })
    await owner.channelConnection.update({
      where: { id: connection.id },
      data: { credentials: sealed() }
    })
    const conversation = await createConversation(owner, {
      storeId,
      customerId: identity.customerId,
      customerIdentityId: identity.id,
      channelType,
      channelConnectionId: connection.id,
      ...(over.status === undefined ? {} : { status: over.status })
    })
    return { id: conversation.id, connectionId: connection.id }
  }

  const failedReply = async (conversationId: string, over: { type?: MessageType } = {}) =>
    owner.message.create({
      data: {
        storeId: ctx.storeA.id,
        conversationId,
        type: over.type ?? MessageType.TEXT,
        content: 'On its way',
        authorType: AuthorType.AGENT,
        authorId: ctx.agentA.id,
        deliveryStatus: DeliveryStatus.FAILED,
        deliveryError: ErrorCodes.CHANNEL_MESSAGE_FAILED,
        createdAt: new Date(Date.now() - 2 * 3_600_000)
      }
    })

  describe('listing the templates of a connection', () => {
    it('lists them for who may send them, from the connection that was named', async () => {
      const { connectionId } = await conversationOn(TEMPLATE_CHANNEL)

      const response = await asAgent()
        .get(ApiRoutes.channels.templates(TEMPLATE_CHANNEL))
        .query({ connectionId })

      expect(response.status).toBe(OK)
      expect(response.body).toEqual([
        { name: 'order_ready', language: 'es', status: 'approved', body: BODY },
        { name: 'promo', language: 'es', status: 'pending', body: 'Sale' }
      ])
    })

    it('is for who may send templates', async () => {
      const { connectionId } = await conversationOn(TEMPLATE_CHANNEL)

      const response = await asViewer()
        .get(ApiRoutes.channels.templates(TEMPLATE_CHANNEL))
        .query({ connectionId })

      expect(response.status).toBe(FORBIDDEN)
      expect(listed).toBe(0)
    })

    it('does not reach a connection of another store, and never asks its provider', async () => {
      const foreign = await conversationOn(TEMPLATE_CHANNEL, { storeId: ctx.storeB.id })

      const response = await asAgent()
        .get(ApiRoutes.channels.templates(TEMPLATE_CHANNEL))
        .query({ connectionId: foreign.connectionId })

      expect(response.status).toBe(NOT_FOUND)
      expect(listed).toBe(0)
    })

    it('is a 404 when the connection belongs to another plugin than the one in the path', async () => {
      const { connectionId } = await conversationOn(TEMPLATE_CHANNEL)

      const response = await asAgent()
        .get(ApiRoutes.channels.templates(PLAIN_CHANNEL))
        .query({ connectionId })

      expect(response.status).toBe(NOT_FOUND)
    })

    it('says so when the channel has no templates', async () => {
      const { connectionId } = await conversationOn(PLAIN_CHANNEL)

      const response = await asAgent()
        .get(ApiRoutes.channels.templates(PLAIN_CHANNEL))
        .query({ connectionId })

      expect(response.status).toBe(CONFLICT)
      expect(codeOf(response.body)).toBe(ErrorCodes.CHANNEL_CAPABILITY_UNSUPPORTED)
    })

    it('needs the connection in the query', async () => {
      const response = await asAgent().get(ApiRoutes.channels.templates(TEMPLATE_CHANNEL))

      expect(response.status).toBe(BAD_REQUEST)
    })

    it('hides what the provider said when it fails, and answers with our code', async () => {
      const { connectionId } = await conversationOn(TEMPLATE_CHANNEL)
      templates = () => Promise.reject(new Error('token=abc123 expired'))

      const response = await asAgent()
        .get(ApiRoutes.channels.templates(TEMPLATE_CHANNEL))
        .query({ connectionId })

      expect(response.status).toBe(INTERNAL_SERVER_ERROR)
      expect(codeOf(response.body)).toBe(ErrorCodes.CHANNEL_MESSAGE_FAILED)
      expect(JSON.stringify(response.body)).not.toContain('abc123')
    })

    it('leaves out a template the plugin got wrong and lists the rest', async () => {
      const { connectionId } = await conversationOn(TEMPLATE_CHANNEL)
      templates = () =>
        Promise.resolve([
          { name: 'x', status: 'draft' },
          { name: 'order_ready', language: 'es', status: 'approved', body: BODY }
        ] as never) // what a plugin that mixes a good template with a bad one lists

      const response = await asAgent()
        .get(ApiRoutes.channels.templates(TEMPLATE_CHANNEL))
        .query({ connectionId })

      expect(response.status).toBe(OK)
      expect((response.body as { name: string }[]).map(item => item.name)).toEqual(['order_ready'])
    })
  })

  describe('writing a template', () => {
    const template = (conversationId: string, extra: Record<string, unknown> = {}) => ({
      type: MessageType.TEMPLATE,
      conversationId,
      templateName: 'order_ready',
      language: 'es',
      variables: ['Ana', '42'],
      idempotencyKey: randomUUID(),
      ...extra
    })

    it('is what a closed window leaves: the text is refused and the template is stored and queued', async () => {
      const { id } = await conversationOn(TEMPLATE_CHANNEL)
      const text = await asAgent().post(ApiRoutes.messages.create).send({
        type: MessageType.TEXT,
        conversationId: id,
        content: 'hi',
        idempotencyKey: randomUUID()
      })
      expect(text.status).toBe(CONFLICT)
      expect(codeOf(text.body)).toBe(ErrorCodes.CHANNEL_WINDOW_EXPIRED)

      const response = await asAgent().post(ApiRoutes.messages.create).send(template(id))

      expect(response.status).toBe(CREATED)
      const body = response.body as MessageBody
      expect(body).toMatchObject({
        type: MessageType.TEMPLATE,
        content: 'Hello Ana, your order 42 is ready',
        deliveryStatus: DeliveryStatus.QUEUED
      })
      expect(JSON.stringify(body)).not.toContain('order_ready')
      const stored = await message(body.id)
      expect(stored.metadata).toEqual({
        template: { name: 'order_ready', language: 'es', variables: ['Ana', '42'] }
      })
      expect(stored.authorId).toBe(ctx.agentA.id)
      const jobs = queueOf(app, QueueNames.OUTBOUND).jobs
      expect(jobs.map(job => job.opts?.jobId)).toEqual([`send-${body.id}`])
    })

    it('is also allowed while the window is open', async () => {
      const { id } = await conversationOn(TEMPLATE_CHANNEL, { windowOpen: true })

      const response = await asAgent().post(ApiRoutes.messages.create).send(template(id))

      expect(response.status).toBe(CREATED)
    })

    it('is stored once for one key, and the second answer is the first message', async () => {
      const { id } = await conversationOn(TEMPLATE_CHANNEL)
      const body = template(id)

      const first = await asAgent().post(ApiRoutes.messages.create).send(body)
      const second = await asAgent().post(ApiRoutes.messages.create).send(body)

      expect(first.status).toBe(CREATED)
      expect(second.status).toBe(OK)
      expect((second.body as MessageBody).id).toBe((first.body as MessageBody).id)
      expect(await owner.message.count({ where: { conversationId: id } })).toBe(1)
    })

    it('answers a repeated key with the first message without asking the provider again', async () => {
      const { id } = await conversationOn(TEMPLATE_CHANNEL)
      const body = template(id)
      const first = await asAgent().post(ApiRoutes.messages.create).send(body)
      expect(first.status).toBe(CREATED)
      listed = 0
      templates = () => Promise.reject(new Error('the provider is down'))

      const second = await asAgent().post(ApiRoutes.messages.create).send(body)

      expect(second.status).toBe(OK)
      expect((second.body as MessageBody).id).toBe((first.body as MessageBody).id)
      expect(listed).toBe(0)
      // The retry also queues a reply the first request may have stored without queuing
      expect(queueOf(app, QueueNames.OUTBOUND).jobs.map(job => job.opts?.jobId)).toEqual([
        `send-${(first.body as MessageBody).id}`,
        `send-${(first.body as MessageBody).id}`
      ])
    })

    it('refuses a key that was used for another template or other values', async () => {
      const { id } = await conversationOn(TEMPLATE_CHANNEL)
      const key = randomUUID()
      await asAgent()
        .post(ApiRoutes.messages.create)
        .send(template(id, { idempotencyKey: key }))
        .expect(CREATED)

      const response = await asAgent()
        .post(ApiRoutes.messages.create)
        .send(template(id, { idempotencyKey: key, variables: ['Bea', '43'] }))

      expect(response.status).toBe(CONFLICT)
      expect(await owner.message.count({ where: { conversationId: id } })).toBe(1)
    })

    it('refuses a template with a placeholder that is not numbered', async () => {
      const { id } = await conversationOn(TEMPLATE_CHANNEL)
      templates = () =>
        Promise.resolve([
          { name: 'named', language: 'es', status: 'approved', body: 'Hi {{customer_name}}' }
        ])

      const response = await asAgent()
        .post(ApiRoutes.messages.create)
        .send(template(id, { templateName: 'named', variables: [] }))

      expect(response.status).toBe(BAD_REQUEST)
    })

    it('refuses a variable that reorders or hides text', async () => {
      const { id } = await conversationOn(TEMPLATE_CHANNEL)

      const response = await asAgent()
        .post(ApiRoutes.messages.create)
        .send(template(id, { variables: ['\u202Eevil', '42'] }))

      expect(response.status).toBe(BAD_REQUEST)
    })

    it('refuses a variable the provider would refuse: a line break, a tab, four spaces', async () => {
      const { id } = await conversationOn(TEMPLATE_CHANNEL)

      for (const value of ['Ana\nPerez', 'Ana\tPerez', 'Ana    Perez']) {
        const response = await asAgent()
          .post(ApiRoutes.messages.create)
          .send(template(id, { variables: [value, '42'] }))
        expect(response.status).toBe(BAD_REQUEST)
      }
    })

    it('refuses a body numbered from zero or with a gap, rather than erasing a placeholder', async () => {
      const { id } = await conversationOn(TEMPLATE_CHANNEL)
      templates = () =>
        Promise.resolve([
          { name: 'from_zero', language: 'es', status: 'approved', body: 'Hi {{0}}' },
          { name: 'gap', language: 'es', status: 'approved', body: 'Hi {{1}} and {{3}}' }
        ])

      const zero = await asAgent()
        .post(ApiRoutes.messages.create)
        .send(template(id, { templateName: 'from_zero', variables: ['Ana'] }))
      const gap = await asAgent()
        .post(ApiRoutes.messages.create)
        .send(template(id, { templateName: 'gap', variables: ['Ana', 'Bea'] }))

      expect(zero.status).toBe(BAD_REQUEST)
      expect(gap.status).toBe(BAD_REQUEST)
    })

    it('refuses a template the provider has not approved', async () => {
      const { id } = await conversationOn(TEMPLATE_CHANNEL)

      const response = await asAgent()
        .post(ApiRoutes.messages.create)
        .send(template(id, { templateName: 'promo', variables: [] }))

      expect(response.status).toBe(CONFLICT)
      expect(codeOf(response.body)).toBe(ErrorCodes.CHANNEL_TEMPLATE_NOT_APPROVED)
      expect(await owner.message.count({ where: { conversationId: id } })).toBe(0)
    })

    it('refuses a template the channel does not have, in that language', async () => {
      const { id } = await conversationOn(TEMPLATE_CHANNEL)

      const wrongName = await asAgent()
        .post(ApiRoutes.messages.create)
        .send(template(id, { templateName: 'nope' }))
      const wrongLanguage = await asAgent()
        .post(ApiRoutes.messages.create)
        .send(template(id, { language: 'en' }))

      expect(wrongName.status).toBe(NOT_FOUND)
      expect(wrongLanguage.status).toBe(NOT_FOUND)
    })

    it.each([
      ['too few variables', ['Ana']],
      ['too many variables', ['Ana', '42', 'extra']]
    ])('refuses %s for the placeholders of the template', async (_name, variables) => {
      const { id } = await conversationOn(TEMPLATE_CHANNEL)

      const response = await asAgent()
        .post(ApiRoutes.messages.create)
        .send(template(id, { variables }))

      expect(response.status).toBe(BAD_REQUEST)
      expect(await owner.message.count({ where: { conversationId: id } })).toBe(0)
    })

    it('refuses a variable that is too long, and a body that carries a field it does not know', async () => {
      const { id } = await conversationOn(TEMPLATE_CHANNEL)

      const long = await asAgent()
        .post(ApiRoutes.messages.create)
        .send(
          template(id, {
            variables: ['x'.repeat(MessageLimits.TEMPLATE_VARIABLE_MAX_LENGTH + 1), '1']
          })
        )
      const extra = await asAgent()
        .post(ApiRoutes.messages.create)
        .send(template(id, { content: 'free text' }))

      expect(long.status).toBe(BAD_REQUEST)
      expect(extra.status).toBe(BAD_REQUEST)
    })

    it('needs the permission to send templates, and not the one for free text', async () => {
      const { id } = await conversationOn(TEMPLATE_CHANNEL)
      const sender = await actorWithPermissions(owner, app, {
        prefix,
        name: 'free-text-only',
        organizationId: ctx.orgA.id,
        storeId: ctx.storeA.id,
        permissions: [
          Permissions.CONVERSATIONS_VIEW,
          Permissions.MESSAGES_VIEW,
          Permissions.MESSAGES_SEND
        ]
      })

      const response = await api(app, sender, ctx.storeA)
        .post(ApiRoutes.messages.create)
        .send(template(id))

      expect(response.status).toBe(FORBIDDEN)
      expect(listed).toBe(0)
    })

    it('does not reach a conversation of another store, and never asks its provider', async () => {
      const foreign = await conversationOn(TEMPLATE_CHANNEL, { storeId: ctx.storeB.id })

      const response = await asAgent().post(ApiRoutes.messages.create).send(template(foreign.id))

      expect(response.status).toBe(NOT_FOUND)
      expect(listed).toBe(0)
      expect(await owner.message.count({ where: { conversationId: foreign.id } })).toBe(0)
    })

    it('is refused on a channel that has no templates', async () => {
      const { id } = await conversationOn(PLAIN_CHANNEL)

      const response = await asAgent().post(ApiRoutes.messages.create).send(template(id))

      expect(response.status).toBe(CONFLICT)
      expect(codeOf(response.body)).toBe(ErrorCodes.CHANNEL_CAPABILITY_UNSUPPORTED)
    })

    it('is not sent to a spam conversation', async () => {
      const { id } = await conversationOn(TEMPLATE_CHANNEL, { status: ConversationStatus.SPAM })

      // A spam conversation is read only by who may archive
      const response = await asAdmin().post(ApiRoutes.messages.create).send(template(id))

      expect(response.status).toBe(CONFLICT)
      expect(codeOf(response.body)).toBe(ErrorCodes.CONVERSATION_INVALID_STATUS_TRANSITION)
    })
  })

  describe('sending a reply again', () => {
    it('puts the same message back on its way, queued, with the error cleared', async () => {
      const { id } = await conversationOn(TEMPLATE_CHANNEL, { windowOpen: true })
      const failed = await failedReply(id)
      const before = new Date()

      const response = await asAgent().post(ApiRoutes.messages.resend(failed.id))

      expect(response.status).toBe(OK)
      expect(response.body).toMatchObject({
        id: failed.id,
        deliveryStatus: DeliveryStatus.QUEUED,
        deliveryError: null
      })
      const stored = await message(failed.id)
      expect(stored.deliveryStatus).toBe(DeliveryStatus.QUEUED)
      expect(stored.resentAt?.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1)
      expect(await owner.message.count({ where: { conversationId: id } })).toBe(1)
      expect(queueOf(app, QueueNames.OUTBOUND).jobs.map(job => job.opts?.jobId)).toEqual([
        `send-${failed.id}`
      ])
    })

    it('sends a template again even when the window closed meanwhile', async () => {
      const { id } = await conversationOn(TEMPLATE_CHANNEL)
      const failed = await failedReply(id, { type: MessageType.TEMPLATE })

      const response = await asAgent().post(ApiRoutes.messages.resend(failed.id))

      expect(response.status).toBe(OK)
    })

    it('answers that the window is closed for a text, which stays failed', async () => {
      const { id } = await conversationOn(TEMPLATE_CHANNEL)
      const failed = await failedReply(id)

      const response = await asAgent().post(ApiRoutes.messages.resend(failed.id))

      expect(response.status).toBe(CONFLICT)
      expect(codeOf(response.body)).toBe(ErrorCodes.CHANNEL_WINDOW_EXPIRED)
      expect((await message(failed.id)).deliveryStatus).toBe(DeliveryStatus.FAILED)
      expect(queueOf(app, QueueNames.OUTBOUND).jobs).toHaveLength(0)
    })

    it.each([
      ['a reply that was sent', DeliveryStatus.SENT],
      ['a reply still queued', DeliveryStatus.QUEUED]
    ])('refuses %s', async (_name, deliveryStatus) => {
      const { id } = await conversationOn(TEMPLATE_CHANNEL, { windowOpen: true })
      const reply = await failedReply(id)
      await owner.message.update({ where: { id: reply.id }, data: { deliveryStatus } })

      const response = await asAgent().post(ApiRoutes.messages.resend(reply.id))

      expect(response.status).toBe(CONFLICT)
      expect(queueOf(app, QueueNames.OUTBOUND).jobs).toHaveLength(0)
    })

    it('refuses a message of the customer, a note and a deleted reply', async () => {
      const { id } = await conversationOn(TEMPLATE_CHANNEL, { windowOpen: true })
      const customers = await createMessage(owner, { storeId: ctx.storeA.id, conversationId: id })
      await owner.message.update({
        where: { id: customers.id },
        data: { deliveryStatus: DeliveryStatus.FAILED }
      })
      const note = await createMessage(owner, {
        storeId: ctx.storeA.id,
        conversationId: id,
        type: MessageType.INTERNAL_NOTE
      })
      await owner.message.update({
        where: { id: note.id },
        data: { deliveryStatus: DeliveryStatus.FAILED }
      })
      const deleted = await failedReply(id)
      await owner.message.update({ where: { id: deleted.id }, data: { deletedAt: new Date() } })

      for (const target of [customers.id, note.id, deleted.id]) {
        const response = await asAgent().post(ApiRoutes.messages.resend(target))
        expect(response.status).toBe(CONFLICT)
      }
      expect(queueOf(app, QueueNames.OUTBOUND).jobs).toHaveLength(0)
    })

    it('is not done to a spam conversation', async () => {
      const { id } = await conversationOn(TEMPLATE_CHANNEL, {
        windowOpen: true,
        status: ConversationStatus.SPAM
      })
      const failed = await failedReply(id)

      const response = await asAgent().post(ApiRoutes.messages.resend(failed.id))

      // A spam conversation is hidden: who may not archive does not even see it
      expect([CONFLICT, NOT_FOUND]).toContain(response.status)
      expect((await message(failed.id)).deliveryStatus).toBe(DeliveryStatus.FAILED)
    })

    it('needs the permission to send templates to send one again', async () => {
      const { id } = await conversationOn(TEMPLATE_CHANNEL)
      const failed = await failedReply(id, { type: MessageType.TEMPLATE })
      const sender = await actorWithPermissions(owner, app, {
        prefix,
        name: 'free-text-only-2',
        organizationId: ctx.orgA.id,
        storeId: ctx.storeA.id,
        permissions: [
          Permissions.CONVERSATIONS_VIEW,
          Permissions.MESSAGES_VIEW,
          Permissions.MESSAGES_SEND
        ]
      })

      const response = await api(app, sender, ctx.storeA).post(ApiRoutes.messages.resend(failed.id))

      expect(response.status).toBe(FORBIDDEN)
      expect((await message(failed.id)).deliveryStatus).toBe(DeliveryStatus.FAILED)
    })

    it('lets who may send templates, and not free text, send a template again', async () => {
      const { id } = await conversationOn(TEMPLATE_CHANNEL)
      const failed = await failedReply(id, { type: MessageType.TEMPLATE })
      const sender = await actorWithPermissions(owner, app, {
        prefix,
        name: 'template-only',
        organizationId: ctx.orgA.id,
        storeId: ctx.storeA.id,
        permissions: [
          Permissions.CONVERSATIONS_VIEW,
          Permissions.MESSAGES_VIEW,
          Permissions.MESSAGES_SEND_TEMPLATE
        ]
      })

      const response = await api(app, sender, ctx.storeA).post(ApiRoutes.messages.resend(failed.id))

      expect(response.status).toBe(OK)
    })

    it('opens a conversation that was resolved since, as writing to the customer does', async () => {
      const { id } = await conversationOn(TEMPLATE_CHANNEL, {
        windowOpen: true,
        status: ConversationStatus.RESOLVED
      })
      const failed = await failedReply(id)

      await asAgent().post(ApiRoutes.messages.resend(failed.id)).expect(OK)

      const conversation = await owner.conversation.findUniqueOrThrow({ where: { id } })
      expect(conversation.status).toBe(ConversationStatus.OPEN)
      expect(conversation.lastOutboundAt).not.toBeNull()
    })

    it('needs the permission to send', async () => {
      const { id } = await conversationOn(TEMPLATE_CHANNEL, { windowOpen: true })
      const failed = await failedReply(id)

      const response = await asViewer().post(ApiRoutes.messages.resend(failed.id))

      expect(response.status).toBe(FORBIDDEN)
    })

    it('does not tell who may not send how a message stands', async () => {
      const { id } = await conversationOn(TEMPLATE_CHANNEL, { windowOpen: true })
      const reply = await failedReply(id)
      await owner.message.update({
        where: { id: reply.id },
        data: { deliveryStatus: DeliveryStatus.SENT }
      })

      const response = await asViewer().post(ApiRoutes.messages.resend(reply.id))

      expect(response.status).toBe(FORBIDDEN)
    })

    it('announces the reply to who sees the conversation once it is open again', async () => {
      const { id } = await conversationOn(TEMPLATE_CHANNEL, {
        windowOpen: true,
        status: ConversationStatus.ARCHIVED
      })
      const failed = await failedReply(id)

      await asAdmin().post(ApiRoutes.messages.resend(failed.id)).expect(OK)

      const conversation = await owner.conversation.findUniqueOrThrow({ where: { id } })
      expect(conversation.status).toBe(ConversationStatus.OPEN)
    })

    it('does not reach a message of another store', async () => {
      const foreign = await conversationOn(TEMPLATE_CHANNEL, { storeId: ctx.storeB.id })
      const failed = await owner.message.create({
        data: {
          storeId: ctx.storeB.id,
          conversationId: foreign.id,
          type: MessageType.TEXT,
          content: 'x',
          authorType: AuthorType.AGENT,
          deliveryStatus: DeliveryStatus.FAILED
        }
      })

      const response = await asAgent().post(ApiRoutes.messages.resend(failed.id))

      expect(response.status).toBe(NOT_FOUND)
      expect((await message(failed.id)).deliveryStatus).toBe(DeliveryStatus.FAILED)
      expect(queueOf(app, QueueNames.OUTBOUND).jobs).toHaveLength(0)
    })

    it('answers 404 for a message that does not exist', async () => {
      const response = await asAgent().post(ApiRoutes.messages.resend(randomUUID()))

      expect(response.status).toBe(NOT_FOUND)
    })
  })

  describe('the message a reply quotes', () => {
    const thread = async (conversationId: string, as = asAgent) =>
      (await as().get(ApiRoutes.conversations.messages(conversationId))).body as ThreadBody
    const replying = (conversationId: string, to: string, content = 'answer') =>
      owner.message.create({
        data: {
          storeId: ctx.storeA.id,
          conversationId,
          type: MessageType.TEXT,
          content,
          authorType: AuthorType.AGENT,
          authorId: ctx.agentA.id,
          replyToMessageId: to,
          deliveryStatus: DeliveryStatus.SENT
        }
      })

    it('comes in the same response, cut to a preview, with who wrote it', async () => {
      const { id } = await conversationOn(PLAIN_CHANNEL, { windowOpen: true })
      const long = 'a'.repeat(MessageLimits.QUOTE_PREVIEW_MAX_LENGTH + 50)
      const original = await createMessage(owner, {
        storeId: ctx.storeA.id,
        conversationId: id,
        content: long
      })
      const answer = await replying(id, original.id)

      const body = await thread(id)

      const quoted = body.data.find(item => item.id === answer.id)?.replyTo
      expect(quoted).toMatchObject({
        id: original.id,
        type: MessageType.TEXT,
        authorType: AuthorType.CUSTOMER,
        deleted: false
      })
      expect(quoted?.content).toBe('a'.repeat(MessageLimits.QUOTE_PREVIEW_MAX_LENGTH))
      expect(body.data.find(item => item.id === original.id)?.replyTo).toBeNull()
    })

    it('has no text once the original was deleted, and says it was', async () => {
      const { id } = await conversationOn(PLAIN_CHANNEL, { windowOpen: true })
      const original = await createMessage(owner, { storeId: ctx.storeA.id, conversationId: id })
      const answer = await replying(id, original.id)
      await owner.message.update({ where: { id: original.id }, data: { deletedAt: new Date() } })

      const quoted = (await thread(id)).data.find(item => item.id === answer.id)?.replyTo

      expect(quoted).toMatchObject({ id: original.id, content: null, deleted: true })
    })

    it('is a note only for who reads notes', async () => {
      const { id } = await conversationOn(PLAIN_CHANNEL, { windowOpen: true })
      const note = await createMessage(owner, {
        storeId: ctx.storeA.id,
        conversationId: id,
        type: MessageType.INTERNAL_NOTE,
        content: 'private'
      })
      const noteAnswer = await owner.message.create({
        data: {
          storeId: ctx.storeA.id,
          conversationId: id,
          type: MessageType.INTERNAL_NOTE,
          content: 'also private',
          authorType: AuthorType.AGENT,
          authorId: ctx.agentA.id,
          replyToMessageId: note.id
        }
      })

      const reader = (await thread(id)).data.find(item => item.id === noteAnswer.id)
      const other = await thread(id, asViewer)

      expect(reader?.replyTo?.content).toBe('private')
      // The viewer does not read notes: neither the note nor what it quotes is in their thread
      expect(JSON.stringify(other)).not.toContain('private')
    })

    it('is null when the original lies in another conversation', async () => {
      const { id } = await conversationOn(PLAIN_CHANNEL, { windowOpen: true })
      const elsewhere = await conversationOn(PLAIN_CHANNEL, { windowOpen: true })
      const foreign = await createMessage(owner, {
        storeId: ctx.storeA.id,
        conversationId: elsewhere.id,
        content: 'from another thread'
      })
      const answer = await replying(id, foreign.id)

      const body = await thread(id)

      expect(body.data.find(item => item.id === answer.id)?.replyTo).toBeNull()
      expect(JSON.stringify(body)).not.toContain('from another thread')
    })

    it('comes in the answer of the create route too, so the bubble does not lose it', async () => {
      const { id } = await conversationOn(PLAIN_CHANNEL, { windowOpen: true })
      const original = await createMessage(owner, { storeId: ctx.storeA.id, conversationId: id })

      const response = await asAgent().post(ApiRoutes.messages.create).send({
        type: MessageType.TEXT,
        conversationId: id,
        content: 'ok',
        idempotencyKey: randomUUID(),
        replyToMessageId: original.id
      })

      expect(response.status).toBe(CREATED)
      expect((response.body as MessageBody).replyTo).toMatchObject({ id: original.id })
    })
  })
})
