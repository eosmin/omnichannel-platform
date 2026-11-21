import type { INestApplication } from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import { AuditAction } from '@platform/core/audit'
import { CredentialCipher } from '@platform/core/crypto'
import { PrismaService, RLS_CONTEXT_ENABLED } from '@platform/core/database'
import { connectionUrls, type OwnerClient } from '@platform/core/database-testing'
import { DeliveryStatus, OrderMessageKind, TemplateStatuses } from '@platform/core/domain'
import { ErrorCodes, HttpStatusCodes } from '@platform/core/errors'
import { Locales } from '@platform/core/i18n'
import { PluginRegistry } from '@platform/plugins/runtime'
import { ChannelCapability, type MessageTemplate } from '@platform/plugins/sdk'

import { buildChannelPlugin, createChannelConnection, createOrder } from '../builders'
import { createTestApp } from '../helpers/app'
import { waitForAuditEntries } from '../helpers/audit'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { api } from '../helpers/http'

const OK = HttpStatusCodes.OK
const WINDOWED = 'io_tpl_windowed'
const APPROVED: MessageTemplate = {
  name: 'order_shipped',
  language: 'es',
  status: TemplateStatuses.APPROVED,
  body: 'Hola {{1}}'
}

// RLS phase 6: the template of an order message that links a template of the channel (the provider is asked whether it exists and is
// approved) and the preview of a message are @NoTenantTransaction. With the interceptor ON and the guard of PrismaService ON, the provider is
// asked with NO tenant context open, the template and its audit entry commit together, and the preview reads in a unit of the store.
describe('RLS phase 6: the templates of the order messages ask the provider with no context open', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let guarded: PrismaService
  let owner: OwnerClient
  let ctx: TestContext
  const opened: { call: string; tenantOpen: boolean }[] = []

  beforeAll(async () => {
    owner = ownerClient()
    guarded = new PrismaService({
      databaseUrl: connectionUrls().worker,
      poolSize: 8,
      requireContext: true
    })
    app = await createTestApp([], builder =>
      builder
        .overrideProvider(PrismaService)
        .useValue(guarded)
        .overrideProvider(RLS_CONTEXT_ENABLED)
        .useValue(true)
    )
    ctx = await seedTestContext(owner, app, prefix)
    app.get(PluginRegistry, { strict: false }).register(
      buildChannelPlugin({
        id: WINDOWED,
        capabilities: [ChannelCapability.TEXT, ChannelCapability.TEMPLATES],
        messagingWindow: { hours: 24, requiresTemplateWhenClosed: true },
        sendTemplate: () =>
          Promise.resolve({
            externalId: 'ext',
            status: DeliveryStatus.SENT,
            sentAt: new Date().toISOString()
          }),
        listTemplates: () => {
          opened.push({ call: 'listTemplates', tenantOpen: guarded.hasTenantContext() })
          return Promise.resolve([APPROVED])
        }
      })
    )
    const connection = await createChannelConnection(owner, {
      storeId: ctx.storeA.id,
      channelType: WINDOWED
    })
    await owner.channelConnection.update({
      where: { id: connection.id },
      data: { credentials: app.get(CredentialCipher, { strict: false }).seal({ token: 'test' }) }
    })
  })
  afterAll(async () => {
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })
  beforeEach(() => {
    opened.length = 0
  })

  const admin = () => api(app, ctx.adminA, ctx.storeA)
  const at = (kind: string, locale: string) =>
    ApiRoutes.orderTemplates.byKindAndLocale(kind, locale)

  it('links a template of the channel: the provider is asked with no context, and the template and its entry are written', async () => {
    const response = await admin()
      .put(at(OrderMessageKind.ORDER_SHIPPED, Locales.ES))
      .send({
        body: 'Shipped {{orderNumber}}',
        channelTemplate: {
          pluginId: WINDOWED,
          name: APPROVED.name,
          language: APPROVED.language,
          variables: ['orderNumber']
        }
      })

    expect(response.status).toBe(OK)
    expect(opened).toEqual([{ call: 'listTemplates', tenantOpen: false }])
    const row = await owner.orderMessageTemplate.findFirstOrThrow({
      where: { storeId: ctx.storeA.id, kind: OrderMessageKind.ORDER_SHIPPED, locale: Locales.ES }
    })
    expect(row.body).toBe('Shipped {{orderNumber}}')
    const entries = await waitForAuditEntries(owner, {
      action: AuditAction.ORDER_TEMPLATE_UPDATED,
      storeId: ctx.storeA.id,
      resourceId: `${OrderMessageKind.ORDER_SHIPPED}:${Locales.ES}`
    })
    expect(entries.length).toBeGreaterThan(0)
  })

  it('writes nothing for a link the channel does not list, and asks with no context', async () => {
    const before = await owner.orderMessageTemplate.count({ where: { storeId: ctx.storeA.id } })

    const response = await admin()
      .put(at(OrderMessageKind.ORDER_DELIVERED, Locales.ES))
      .send({
        body: 'Delivered {{orderNumber}}',
        channelTemplate: {
          pluginId: WINDOWED,
          name: 'not_listed',
          language: 'es',
          variables: ['orderNumber']
        }
      })

    // The refusal comes from the check of the link (the channel does not list it), not from the declaration of the channel
    expect(response.status).toBe(HttpStatusCodes.BAD_REQUEST)
    expect((response.body as { error: { code: string } }).error.code).toBe(
      ErrorCodes.ORDER_TEMPLATE_CHANNEL_TEMPLATE_MISSING
    )
    expect(opened).toEqual([{ call: 'listTemplates', tenantOpen: false }])
    expect(await owner.orderMessageTemplate.count({ where: { storeId: ctx.storeA.id } })).toBe(
      before
    )
  })

  it('previews a message under the guard: the order, the consent and the template are read in a unit of the store', async () => {
    const order = await createOrder(owner, {
      storeId: ctx.storeA.id,
      status: 'CONFIRMED',
      shippingAddress: { line1: '1 Main St', city: 'San Salvador', country: 'SV' }
    })
    const row = await owner.order.findFirstOrThrow({
      where: { id: order.id },
      select: { customerId: true }
    })
    await owner.customer.update({ where: { id: row.customerId }, data: { name: 'Ana' } })
    await admin()
      .put(at(OrderMessageKind.ORDER_SHIPPED, Locales.ES))
      .send({ body: 'Hola {{customerName}}, {{orderNumber}}' })
      .expect(OK)

    const response = await admin()
      .post(`${ApiRoutes.orders.messages(order.id)}?preview=true`)
      .send({ kind: OrderMessageKind.ORDER_SHIPPED })

    expect(response.status).toBe(OK)
    expect(response.body).toMatchObject({ preview: true, ok: true })
  })
})
