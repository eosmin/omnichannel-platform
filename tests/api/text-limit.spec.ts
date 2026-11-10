import { randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import type { OwnerClient } from '@platform/core/database-testing'
import { AuthorType, ChannelIds, DeliveryStatus, MessageType } from '@platform/core/domain'
import { QueueNames } from '@platform/core/queues'
import { PluginRegistry } from '@platform/plugins/runtime'
import { ChannelCapability } from '@platform/plugins/sdk'

import {
  buildChannelPlugin,
  createChannelConnection,
  createConversation,
  createCustomerIdentity
} from '../builders'
import { createTestApp } from '../helpers/app'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { withToyChannel } from '../helpers/env'
import { api } from '../helpers/http'
import { queueOf } from '../helpers/queue'

const CREATED = 201
const OK = 200
const BAD_REQUEST = 400
const TOY_ID = 'acme_chat'
const EDITABLE_ID = 'editable_text_channel'
const EDITABLE_LIMIT = 30

// The longest plain text each channel takes, from what its plugin declares. The api refuses the next
// character with a 400 before the message exists or anything is queued, so the agent hears it at once
// instead of reading a failed reply later.
describe('a text longer than its channel holds', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext

  beforeAll(async () => {
    owner = ownerClient()
    app = await withToyChannel(() => createTestApp())
    ctx = await seedTestContext(owner, app, prefix)
    app.get(PluginRegistry, { strict: false }).register(
      buildChannelPlugin({
        id: EDITABLE_ID,
        capabilities: [ChannelCapability.TEXT, ChannelCapability.EDIT_MESSAGE],
        limits: { textMaxLength: EDITABLE_LIMIT },
        editMessage: () => Promise.resolve()
      })
    )
  })
  afterAll(async () => {
    await cleanUp(owner, prefix)
    await owner.plugin.deleteMany({ where: { id: TOY_ID } })
    await app.close()
    await owner.$disconnect()
  })
  beforeEach(() => {
    queueOf(app, QueueNames.OUTBOUND).jobs.length = 0
  })

  const asAgent = () => api(app, ctx.agentA, ctx.storeA)
  const limitOf = (pluginId: string) =>
    app.get(PluginRegistry, { strict: false }).limitsOf(pluginId)?.textMaxLength ?? 0
  const conversationOn = async (pluginId: string): Promise<string> => {
    const storeId = ctx.storeA.id
    const identity = await createCustomerIdentity(owner, { storeId, channelType: pluginId })
    const connection = await createChannelConnection(owner, { storeId, channelType: pluginId })
    const conversation = await createConversation(owner, {
      storeId,
      customerId: identity.customerId,
      customerIdentityId: identity.id,
      channelType: pluginId,
      channelConnectionId: connection.id
    })
    return conversation.id
  }
  const send = (conversationId: string, content: string, type: string = MessageType.TEXT) =>
    asAgent()
      .post(ApiRoutes.messages.create)
      .send({ type, conversationId, content, idempotencyKey: randomUUID() })
  const messagesOf = (conversationId: string) =>
    owner.message.findMany({ where: { conversationId } })

  // WhatsApp holds the general limit of the DTO too, so its case does not prove the channel check alone; the
  // other three do
  describe.each([ChannelIds.WHATSAPP, ChannelIds.MESSENGER, ChannelIds.INSTAGRAM, TOY_ID])(
    'on %s',
    pluginId => {
      it('takes a text of exactly the limit of the channel and queues it', async () => {
        const id = await conversationOn(pluginId)

        const response = await send(id, 'x'.repeat(limitOf(pluginId)))

        expect(response.status).toBe(CREATED)
        expect(queueOf(app, QueueNames.OUTBOUND).jobs).toHaveLength(1)
      })

      it('refuses one character more with a 400, creates nothing and queues nothing', async () => {
        const id = await conversationOn(pluginId)

        const response = await send(id, 'x'.repeat(limitOf(pluginId) + 1))

        expect(response.status).toBe(BAD_REQUEST)
        expect(JSON.stringify(response.body)).toContain(String(limitOf(pluginId)))
        expect(await messagesOf(id)).toHaveLength(0)
        expect(queueOf(app, QueueNames.OUTBOUND).jobs).toHaveLength(0)
      })
    }
  )

  it('counts characters, not UTF-16 units, as the channel does', async () => {
    const id = await conversationOn(TOY_ID)

    const fits = await send(id, '😀'.repeat(limitOf(TOY_ID)))
    const over = await send(await conversationOn(TOY_ID), '😀'.repeat(limitOf(TOY_ID) + 1))

    expect(fits.status).toBe(CREATED)
    expect(over.status).toBe(BAD_REQUEST)
  })

  it('does not hold an internal note to the limit of a channel: it never leaves the team', async () => {
    const id = await conversationOn(TOY_ID)

    const response = await send(id, 'x'.repeat(limitOf(TOY_ID) + 1), MessageType.INTERNAL_NOTE)

    expect(response.status).toBe(CREATED)
    expect(queueOf(app, QueueNames.OUTBOUND).jobs).toHaveLength(0)
  })

  describe('editing a reply', () => {
    const replyOn = async (): Promise<string> => {
      const conversationId = await conversationOn(EDITABLE_ID)
      const row = await owner.message.create({
        data: {
          storeId: ctx.storeA.id,
          conversationId,
          type: MessageType.TEXT,
          content: 'first text',
          authorType: AuthorType.AGENT,
          authorId: ctx.agentA.id,
          deliveryStatus: DeliveryStatus.SENT,
          channelMessageId: `ext-${randomUUID()}`
        },
        select: { id: true }
      })
      return row.id
    }
    const edit = (id: string, content: string) =>
      asAgent().patch(ApiRoutes.messages.byId(id)).send({ content })

    it('takes a new text of exactly the limit', async () => {
      const id = await replyOn()

      const response = await edit(id, 'y'.repeat(EDITABLE_LIMIT))

      expect(response.status).toBe(OK)
    })

    it('refuses one character more with a 400 and leaves the message as it was', async () => {
      const id = await replyOn()

      const response = await edit(id, 'y'.repeat(EDITABLE_LIMIT + 1))

      expect(response.status).toBe(BAD_REQUEST)
      const stored = await owner.message.findUniqueOrThrow({
        where: { id },
        select: { content: true, pendingContent: true, editStatus: true, version: true }
      })
      expect(stored).toMatchObject({
        content: 'first text',
        pendingContent: null,
        editStatus: null
      })
      expect(queueOf(app, QueueNames.OUTBOUND).jobs).toHaveLength(0)
    })
  })
})
