import { randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import { Permissions } from '@platform/core/auth'
import type { OwnerClient } from '@platform/core/database-testing'
import {
  ChannelType,
  ConversationStatus,
  type MessagingWindowPolicy,
  MessageType
} from '@platform/core/domain'
import { ErrorCodes } from '@platform/core/errors'
import {
  MESSAGING_WINDOW_POLICIES,
  type MessagingWindowPolicySource
} from '@platform/core/messaging'

import { createConversationOf } from '../builders'
import { actorWithPermissions } from '../helpers/actors'
import { createTestApp } from '../helpers/app'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { anonymousApi, api } from '../helpers/http'

interface WindowBody {
  open: boolean
  closesAt: string | null
  requiresTemplate: boolean
}
interface ErrorBody {
  error: { code: string; metadata?: { requiresTemplate?: boolean } }
}

const OK = 200
const CREATED = 201
const UNAUTHORIZED = 401
const FORBIDDEN = 403
const NOT_FOUND = 404
const CONFLICT = 409
const HOUR_MS = 60 * 60 * 1000

const hoursAgo = (hours: number) => new Date(Date.now() - hours * HOUR_MS)
const WHATSAPP: MessagingWindowPolicy = { hours: 24, requiresTemplateWhenClosed: true }
const INSTAGRAM: MessagingWindowPolicy = { hours: 24, requiresTemplateWhenClosed: false }

describe('The messaging window of a conversation', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  let source: MessagingWindowPolicySource
  let original: MessagingWindowPolicySource['policyFor']
  let policies: Record<string, MessagingWindowPolicy> = {}

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp()
    ctx = await seedTestContext(owner, app, prefix)
    // The plugins do not exist yet: the suite is the plugin registry, with the policies it sets
    source = app.get<MessagingWindowPolicySource>(MESSAGING_WINDOW_POLICIES, { strict: false })
    original = source.policyFor.bind(source)
    source.policyFor = channelType => policies[channelType] ?? null
  })
  afterAll(async () => {
    source.policyFor = original
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })
  beforeEach(() => {
    policies = { [ChannelType.WHATSAPP]: WHATSAPP, [ChannelType.INSTAGRAM]: INSTAGRAM }
  })

  const asAdmin = () => api(app, ctx.adminA, ctx.storeA)
  const asAgent = () => api(app, ctx.agentA, ctx.storeA)
  const codeOf = (body: unknown) => (body as ErrorBody).error.code
  // A conversation whose customer last wrote the given hours ago (null: never)
  const conversation = async (
    lastInboundHoursAgo: number | null,
    extra: Partial<Parameters<typeof createConversationOf>[1]> & { channelType?: string } = {}
  ) => {
    const made = await createConversationOf(owner, {
      storeId: ctx.storeA.id,
      channelType: ChannelType.WHATSAPP,
      ...extra
    })
    if (lastInboundHoursAgo !== null) {
      await owner.customerIdentity.update({
        where: { id: made.customerIdentityId },
        data: { lastInboundAt: hoursAgo(lastInboundHoursAgo) }
      })
    }
    return made
  }
  const windowOf = (id: string) => asAgent().get(ApiRoutes.conversations.messagingWindow(id))
  const reply = (conversationId: string, extra: Record<string, unknown> = {}) => ({
    type: MessageType.TEXT,
    conversationId,
    content: 'Hello',
    idempotencyKey: randomUUID(),
    ...extra
  })

  describe('the state it reports', () => {
    it('is open with the date it closes while the customer wrote within the hours', async () => {
      const made = await conversation(2)
      const lastInboundAt = (
        await owner.customerIdentity.findUniqueOrThrow({ where: { id: made.customerIdentityId } })
      ).lastInboundAt

      const response = await windowOf(made.id)

      expect(response.status).toBe(OK)
      const body = response.body as WindowBody
      expect(body.open).toBe(true)
      expect(body.requiresTemplate).toBe(false)
      expect(new Date(body.closesAt ?? '').getTime()).toBe(
        (lastInboundAt?.getTime() ?? 0) + 24 * HOUR_MS
      )
    })

    it('is closed and asks for a template on WhatsApp after the hours', async () => {
      const made = await conversation(25)

      const body = (await windowOf(made.id)).body as WindowBody

      expect(body).toMatchObject({ open: false, requiresTemplate: true })
      expect(body.closesAt).not.toBeNull()
    })

    it('is closed and asks for no template on a channel that lets none through', async () => {
      const made = await conversation(25, { channelType: ChannelType.INSTAGRAM })

      const body = (await windowOf(made.id)).body as WindowBody

      expect(body).toMatchObject({ open: false, requiresTemplate: false })
    })

    it('is closed, with no date, for a customer who never wrote', async () => {
      const made = await conversation(null)

      const body = (await windowOf(made.id)).body as WindowBody

      expect(body).toEqual({ open: false, closesAt: null, requiresTemplate: true })
    })

    it('has no window on a channel with no policy', async () => {
      const made = await conversation(null, { channelType: ChannelType.EMAIL })

      const body = (await windowOf(made.id)).body as WindowBody

      expect(body).toEqual({ open: true, closesAt: null, requiresTemplate: false })
    })

    it('belongs to the identity of the customer: two conversations of one identity share it', async () => {
      const first = await conversation(1)
      const second = await createConversationOf(owner, {
        storeId: ctx.storeA.id,
        channelType: ChannelType.WHATSAPP
      })
      // The second conversation is of the same identity
      await owner.conversation.update({
        where: { id: second.id },
        data: {
          customerIdentityId: first.customerIdentityId,
          customerId: first.customerId
        }
      })

      const one = (await windowOf(first.id)).body as WindowBody
      const two = (await windowOf(second.id)).body as WindowBody

      expect(two).toEqual(one)
      expect(two.open).toBe(true)
    })
  })

  describe('who may ask', () => {
    it('answers 401 with no token', async () => {
      const made = await conversation(1)

      const response = await anonymousApi(app).get(ApiRoutes.conversations.messagingWindow(made.id))

      expect(response.status).toBe(UNAUTHORIZED)
    })

    it('needs the permission to see conversations', async () => {
      const made = await conversation(1)
      const blind = await actorWithPermissions(owner, app, {
        prefix,
        name: `windowBlind${randomUUID().slice(0, 6)}`,
        organizationId: ctx.orgA.id,
        storeId: ctx.storeA.id,
        permissions: [Permissions.TEAM_VIEW]
      })

      const response = await api(app, blind, ctx.storeA).get(
        ApiRoutes.conversations.messagingWindow(made.id)
      )

      expect(response.status).toBe(FORBIDDEN)
    })

    it('does not know a conversation the caller cannot see, nor one of another store', async () => {
      const assignedToOther = await conversation(1, { assignedTo: ctx.adminA.id })
      const archived = await conversation(1, { status: ConversationStatus.ARCHIVED })
      const foreign = await createConversationOf(owner, { storeId: ctx.storeB.id })

      const answers = [
        await windowOf(assignedToOther.id),
        await windowOf(archived.id),
        await windowOf(foreign.id),
        await windowOf(randomUUID())
      ]

      expect(answers.map(answer => answer.status)).toEqual([
        NOT_FOUND,
        NOT_FOUND,
        NOT_FOUND,
        NOT_FOUND
      ])
      const errors = answers.map(answer => (answer.body as ErrorBody).error)
      expect(new Set(errors.map(error => JSON.stringify(error))).size).toBe(1)
      expect(
        (await asAdmin().get(ApiRoutes.conversations.messagingWindow(archived.id))).status
      ).toBe(OK)
    })
  })

  describe('answering with it closed', () => {
    it('refuses a reply with CHANNEL_WINDOW_EXPIRED and says a template would do', async () => {
      const made = await conversation(30, { status: ConversationStatus.RESOLVED })
      const before = await owner.conversation.findUniqueOrThrow({ where: { id: made.id } })

      const response = await asAgent().post(ApiRoutes.messages.create).send(reply(made.id))

      expect(response.status).toBe(CONFLICT)
      expect(codeOf(response.body)).toBe(ErrorCodes.CHANNEL_WINDOW_EXPIRED)
      expect((response.body as ErrorBody).error.metadata?.requiresTemplate).toBe(true)
      expect(await owner.message.count({ where: { conversationId: made.id } })).toBe(0)
      // The refusal leaves the conversation as it was: it is not reopened, no date moves
      const after = await owner.conversation.findUniqueOrThrow({ where: { id: made.id } })
      expect(after.status).toBe(ConversationStatus.RESOLVED)
      expect(after.lastMessageAt).toEqual(before.lastMessageAt)
      expect(after.firstResponseAt).toBeNull()
    })

    it('says no template would do on a channel that has none', async () => {
      const made = await conversation(30, { channelType: ChannelType.INSTAGRAM })

      const response = await asAgent().post(ApiRoutes.messages.create).send(reply(made.id))

      expect(codeOf(response.body)).toBe(ErrorCodes.CHANNEL_WINDOW_EXPIRED)
      expect((response.body as ErrorBody).error.metadata?.requiresTemplate).toBe(false)
    })

    it('refuses a reply to a customer who never wrote', async () => {
      const made = await conversation(null)

      const response = await asAgent().post(ApiRoutes.messages.create).send(reply(made.id))

      expect(codeOf(response.body)).toBe(ErrorCodes.CHANNEL_WINDOW_EXPIRED)
    })

    it('lets an internal note through: it is the team’s and goes to nobody', async () => {
      const made = await conversation(30)

      const response = await asAgent().post(ApiRoutes.messages.create).send({
        type: MessageType.INTERNAL_NOTE,
        conversationId: made.id,
        content: 'Call them tomorrow'
      })

      expect(response.status).toBe(CREATED)
    })

    it('answers a retry of a reply sent while the window was open, even after it closed', async () => {
      const made = await conversation(1)
      const body = reply(made.id)
      const first = await asAgent().post(ApiRoutes.messages.create).send(body)
      await owner.customerIdentity.update({
        where: { id: made.customerIdentityId },
        data: { lastInboundAt: hoursAgo(30) }
      })

      const retry = await asAgent().post(ApiRoutes.messages.create).send(body)

      expect(first.status).toBe(CREATED)
      expect(retry.status).toBe(OK)
      expect((retry.body as { id: string }).id).toBe((first.body as { id: string }).id)
    })

    it('answers again once a new message of the customer renews the window', async () => {
      const made = await conversation(30)
      expect((await asAgent().post(ApiRoutes.messages.create).send(reply(made.id))).status).toBe(
        CONFLICT
      )

      await owner.customerIdentity.update({
        where: { id: made.customerIdentityId },
        data: { lastInboundAt: new Date() }
      })

      const response = await asAgent().post(ApiRoutes.messages.create).send(reply(made.id))

      expect(response.status).toBe(CREATED)
    })
  })

  describe('answering with it open or without one', () => {
    it('stores the reply while the window is open', async () => {
      const made = await conversation(1)

      const response = await asAgent().post(ApiRoutes.messages.create).send(reply(made.id))

      expect(response.status).toBe(CREATED)
    })

    it('stores the reply on a channel with no window, whenever the customer wrote', async () => {
      const made = await conversation(null, { channelType: ChannelType.EMAIL })

      const response = await asAgent().post(ApiRoutes.messages.create).send(reply(made.id))

      expect(response.status).toBe(CREATED)
    })

    it('does not look at the window of another channel', async () => {
      policies = { [ChannelType.INSTAGRAM]: INSTAGRAM }
      const made = await conversation(null, { channelType: ChannelType.WHATSAPP })

      const response = await asAgent().post(ApiRoutes.messages.create).send(reply(made.id))

      expect(response.status).toBe(CREATED)
    })
  })
})
