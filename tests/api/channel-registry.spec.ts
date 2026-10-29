import type { INestApplication } from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import type { OwnerClient } from '@platform/core/database-testing'
import { ErrorCodes } from '@platform/core/errors'
import {
  MESSAGING_WINDOW_POLICIES,
  type MessagingWindowPolicySource
} from '@platform/core/messaging'
import { PluginRegistry } from '@platform/plugins/runtime'

import {
  buildChannelPlugin,
  createConversationOf,
  createCustomer,
  TEST_CHANNEL_ID
} from '../builders'
import { createTestApp } from '../helpers/app'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { api } from '../helpers/http'

const OK = 200
const CREATED = 201
const BAD_REQUEST = 400
const PRIVATE_ID = 'private_chat'

interface ErrorBody {
  error: { code: string; metadata?: { channels?: string[] } }
}

// A channel is the id of a registered plugin, not a value of a closed list (Step 2.5)
describe('The channels that routes take', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp()
    ctx = await seedTestContext(owner, app, prefix)
    const registry = app.get(PluginRegistry, { strict: false })
    registry.register(buildChannelPlugin())
    // Private to store A2: store A must not see it
    registry.register(buildChannelPlugin({ id: PRIVATE_ID }), { storeIds: [ctx.storeA2.id] })
  })
  afterAll(async () => {
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })

  const asAdmin = () => api(app, ctx.adminA, ctx.storeA)
  const asAdminOfA2 = () => api(app, ctx.adminA2, ctx.storeA2)
  const codeOf = (body: unknown) => (body as ErrorBody).error.code

  describe('a conversation filter', () => {
    it('takes the id of a registered plugin, also one that is not official', async () => {
      await createConversationOf(owner, { storeId: ctx.storeA.id, channelType: TEST_CHANNEL_ID })

      const response = await asAdmin()
        .get(ApiRoutes.conversations.list)
        .query({ channelType: TEST_CHANNEL_ID })

      expect(response.status).toBe(OK)
      expect((response.body as { data: unknown[] }).data.length).toBeGreaterThan(0)
    })

    it.each(['telegram', PRIVATE_ID])(
      'is an empty page for %s: a filter only reads, and says nothing of other stores',
      async id => {
        const response = await asAdmin()
          .get(ApiRoutes.conversations.list)
          .query({ channelType: id })

        expect(response.status).toBe(OK)
        expect((response.body as { data: unknown[] }).data).toEqual([])
      }
    )

    it('answers 400 for an id that is not shaped like one', async () => {
      const response = await asAdmin()
        .get(ApiRoutes.conversations.list)
        .query({ channelType: 'Not An Id' })
      expect(response.status).toBe(BAD_REQUEST)
    })
  })

  describe('a routing condition', () => {
    const rule = (channelTypes: string[]) => ({
      name: 'By channel',
      enabled: true,
      conditions: { channelTypes },
      action: { type: 'unassigned' }
    })

    it('takes registered ids', async () => {
      const response = await asAdmin()
        .post(ApiRoutes.settings.routing)
        .send(rule(['whatsapp', TEST_CHANNEL_ID]))
      expect(response.status).toBe(CREATED)
    })

    it('answers 400 and names the ids it does not know, without writing the rule', async () => {
      const before = await owner.routingRule.count({ where: { storeId: ctx.storeA.id } })

      const response = await asAdmin()
        .post(ApiRoutes.settings.routing)
        .send(rule([TEST_CHANNEL_ID, 'telegram', PRIVATE_ID]))

      expect(response.status).toBe(BAD_REQUEST)
      expect(codeOf(response.body)).toBe(ErrorCodes.VALIDATION_FAILED)
      expect((response.body as ErrorBody).error.metadata?.channels).toEqual([
        'telegram',
        PRIVATE_ID
      ])
      expect(await owner.routingRule.count({ where: { storeId: ctx.storeA.id } })).toBe(before)
    })

    it('lets a rule be edited when it names a channel that is no longer registered', async () => {
      const created = await asAdmin()
        .post(ApiRoutes.settings.routing)
        .send(rule(['whatsapp']))
      const id = (created.body as { id: string }).id
      // The plugin is gone: the row keeps the id
      await owner.routingRule.update({
        where: { id },
        data: { conditions: { channelTypes: ['whatsapp', 'gone_chat'] } }
      })

      const renamed = await asAdmin()
        .patch(ApiRoutes.settings.routingRuleById(id))
        .send({ name: 'Renamed', conditions: { channelTypes: ['whatsapp', 'gone_chat'] } })
      const added = await asAdmin()
        .patch(ApiRoutes.settings.routingRuleById(id))
        .send({ conditions: { channelTypes: ['whatsapp', 'gone_chat', 'telegram'] } })

      expect(renamed.status).toBe(OK)
      expect(added.status).toBe(BAD_REQUEST)
      expect((added.body as ErrorBody).error.metadata?.channels).toEqual(['telegram'])
    })

    it('checks the channels of an update as well', async () => {
      const created = await asAdmin()
        .post(ApiRoutes.settings.routing)
        .send(rule(['whatsapp']))
      const id = (created.body as { id: string }).id

      const response = await asAdmin()
        .patch(ApiRoutes.settings.routingRuleById(id))
        .send({ conditions: { channelTypes: ['telegram'] } })

      expect(response.status).toBe(BAD_REQUEST)
    })
  })

  describe('linking an identity', () => {
    it('answers 400 for a channel nobody registered', async () => {
      const customer = await createCustomer(owner, { storeId: ctx.storeA.id })

      const response = await asAdmin()
        .post(ApiRoutes.customers.identities(customer.id))
        .send({ channelType: 'telegram', channelIdentity: 'ana' })

      expect(response.status).toBe(BAD_REQUEST)
    })

    it('takes a registered channel that is not official', async () => {
      const customer = await createCustomer(owner, { storeId: ctx.storeA.id })

      const response = await asAdmin()
        .post(ApiRoutes.customers.identities(customer.id))
        .send({ channelType: TEST_CHANNEL_ID, channelIdentity: 'ana' })

      expect(response.status).toBe(CREATED)
    })
  })

  describe('a plugin private to a store', () => {
    const rule = (channelTypes: string[]) => ({
      name: 'Private',
      enabled: true,
      conditions: { channelTypes },
      action: { type: 'unassigned' }
    })

    it('can be used by the store it was registered for, and by no other', async () => {
      const mine = await asAdminOfA2()
        .post(ApiRoutes.settings.routing)
        .send(rule([PRIVATE_ID]))
      const theirs = await asAdmin()
        .post(ApiRoutes.settings.routing)
        .send(rule([PRIVATE_ID]))
      const unknown = await asAdmin()
        .post(ApiRoutes.settings.routing)
        .send(rule(['telegram']))

      expect(mine.status).toBe(CREATED)
      expect(theirs.status).toBe(BAD_REQUEST)
      // The same answer as for an id nobody registered: it says nothing of the plugin of another store
      expect(codeOf(theirs.body)).toBe(codeOf(unknown.body))
      expect(theirs.status).toBe(unknown.status)
    })

    it('cannot be added to a rule of another store, nor linked as an identity there', async () => {
      const created = await asAdmin()
        .post(ApiRoutes.settings.routing)
        .send(rule(['whatsapp']))
      const id = (created.body as { id: string }).id
      const customer = await createCustomer(owner, { storeId: ctx.storeA.id })

      const update = await asAdmin()
        .patch(ApiRoutes.settings.routingRuleById(id))
        .send({ conditions: { channelTypes: ['whatsapp', PRIVATE_ID] } })
      const link = await asAdmin()
        .post(ApiRoutes.customers.identities(customer.id))
        .send({ channelType: PRIVATE_ID, channelIdentity: 'ana' })

      expect(update.status).toBe(BAD_REQUEST)
      expect(link.status).toBe(BAD_REQUEST)
    })

    it('can be linked as an identity by its own store', async () => {
      const customer = await createCustomer(owner, { storeId: ctx.storeA2.id })

      const link = await asAdminOfA2()
        .post(ApiRoutes.customers.identities(customer.id))
        .send({ channelType: PRIVATE_ID, channelIdentity: 'ana' })

      expect(link.status).toBe(CREATED)
    })
  })

  describe('the official channels', () => {
    it('are accepted before their plugins exist (Steps 2.7 and 2.8)', async () => {
      const customer = await createCustomer(owner, { storeId: ctx.storeA.id })

      const link = await asAdmin()
        .post(ApiRoutes.customers.identities(customer.id))
        .send({ channelType: 'web_widget', channelIdentity: 'visitor-1234' })

      expect(link.status).toBe(CREATED)
    })
  })

  describe('an identity whose plugin was removed', () => {
    it('is still answered when it is linked again, because nothing is written', async () => {
      const customer = await createCustomer(owner, { storeId: ctx.storeA.id })
      await owner.customerIdentity.create({
        data: {
          storeId: ctx.storeA.id,
          customerId: customer.id,
          channelType: 'gone_chat',
          channelIdentity: 'ana'
        }
      })

      const again = await asAdmin()
        .post(ApiRoutes.customers.identities(customer.id))
        .send({ channelType: 'gone_chat', channelIdentity: 'ana' })

      expect(again.status).toBe(OK)
    })
  })

  describe('the messaging window', () => {
    it('is the policy of the registered plugin, and none for a channel without one', () => {
      const source = app.get<MessagingWindowPolicySource>(MESSAGING_WINDOW_POLICIES, {
        strict: false
      })

      expect(source.policyFor(TEST_CHANNEL_ID)).toEqual({
        hours: 24,
        requiresTemplateWhenClosed: false
      })
      // WhatsApp is an official plugin now: its window is the one it declares
      expect(source.policyFor('whatsapp')).toEqual({ hours: 24, requiresTemplateWhenClosed: true })
      expect(source.policyFor('telegram')).toBeNull()
    })
  })
})
