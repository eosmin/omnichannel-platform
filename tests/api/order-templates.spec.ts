import type { INestApplication } from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import { AuditAction } from '@platform/core/audit'
import { Permissions } from '@platform/core/auth'
import { CredentialCipher } from '@platform/core/crypto'
import { type OwnerClient } from '@platform/core/database-testing'
import {
  DeliveryStatus,
  OrderMessageKind,
  OrderMessageVariables,
  OrderMessageWarnings,
  type TemplateStatus,
  TemplateStatuses
} from '@platform/core/domain'
import { ErrorCodes } from '@platform/core/errors'
import { Locales } from '@platform/core/i18n'
import { PluginRegistry } from '@platform/plugins/runtime'
import { ChannelCapability } from '@platform/plugins/sdk'

import { OrderTemplatesService } from '../../apps/api/src/modules/order-messages/order-templates.service'
import {
  buildChannelPlugin,
  createChannelConnection,
  createOrderMessageTemplate
} from '../builders'
import { actorWithPermissions } from '../helpers/actors'
import { createTestApp } from '../helpers/app'
import { waitForAuditEntries } from '../helpers/audit'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { api } from '../helpers/http'

const OK = 200
const NO_CONTENT = 204
const BAD_REQUEST = 400
const FORBIDDEN = 403
const NOT_FOUND = 404
const CONFLICT = 409

interface ErrorBody {
  error: { code: string }
}
interface TemplateBody {
  kind: string
  locale: string
  body: string
  autoSend: boolean
  attachSummary: boolean
  channelTemplate: { pluginId: string; name: string; language: string; variables: string[] } | null
  variables: string[]
  warnings: string[]
}

// A channel that asks for an approved template when its window is closed, one that has templates but no window, and one that
// has a window but no templates: the three answers of the declaration, never the name of the plugin (rule 13)
const WINDOWED = 'tpl_windowed'
const NO_WINDOW = 'tpl_no_window'
const NO_TEMPLATES = 'tpl_no_templates'

// Settings → Order messages (TDD_17 §4.7, Step 4.9 PR C1): the templates of the messages of an order, per kind and language.
describe('Settings → Order messages', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  let reader: Awaited<ReturnType<typeof actorWithPermissions>>
  // What the channels answer when asked for their approved templates
  let listed: { name: string; language: string; status: TemplateStatus; body: string }[] = []
  let listingFails = false

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp()
    ctx = await seedTestContext(owner, app, prefix)
    const registry = app.get(PluginRegistry, { strict: false })
    const withTemplates = [ChannelCapability.TEXT, ChannelCapability.TEMPLATES]
    // A channel that declares templates must be able to send and list them (the contract of the registry)
    const templateMethods = {
      sendTemplate: () =>
        Promise.resolve({
          externalId: 'ext',
          status: DeliveryStatus.SENT,
          sentAt: new Date().toISOString()
        }),
      listTemplates: () =>
        listingFails ? Promise.reject(new Error('timeout')) : Promise.resolve(listed)
    }
    registry.register(
      buildChannelPlugin({
        id: WINDOWED,
        capabilities: withTemplates,
        messagingWindow: { hours: 24, requiresTemplateWhenClosed: true },
        ...templateMethods
      })
    )
    registry.register(
      buildChannelPlugin({
        id: NO_WINDOW,
        capabilities: withTemplates,
        messagingWindow: null,
        ...templateMethods
      })
    )
    registry.register(
      buildChannelPlugin({
        id: NO_TEMPLATES,
        capabilities: [ChannelCapability.TEXT],
        messagingWindow: { hours: 24, requiresTemplateWhenClosed: true }
      })
    )
    reader = await actorWithPermissions(owner, app, {
      prefix,
      name: 'reader',
      organizationId: ctx.orgA.id,
      storeId: ctx.storeA.id,
      permissions: [Permissions.ORDERS_VIEW]
    })
  })
  afterAll(async () => {
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })

  const asAdmin = () => api(app, ctx.adminA, ctx.storeA)
  const asAdminB = () => api(app, ctx.adminB, ctx.storeB)
  const codeOf = (body: unknown) => (body as ErrorBody).error.code
  const at = (kind: string, locale: string) =>
    ApiRoutes.orderTemplates.byKindAndLocale(kind, locale)
  const put = (kind: string, locale: string, body: object) =>
    asAdmin().put(at(kind, locale)).send(body)

  describe('writing a template', () => {
    it('creates it, takes the default of its kind for autoSend and reads it back', async () => {
      const response = await put(OrderMessageKind.ORDER_SHIPPED, Locales.ES, {
        body: 'Hola {{customerName}}, tu pedido {{orderNumber}} va en camino'
      })

      expect(response.status).toBe(OK)
      expect(response.body).toMatchObject({
        kind: 'order_shipped',
        locale: 'es',
        autoSend: true,
        attachSummary: false,
        channelTemplate: null,
        variables: ['customerName', 'orderNumber'],
        warnings: []
      })
      const read = await asAdmin().get(at(OrderMessageKind.ORDER_SHIPPED, Locales.ES))
      expect(read.status).toBe(OK)
      expect((read.body as TemplateBody).body).toContain('va en camino')
    })

    it('starts the kinds that need a person without autoSend, and replaces the whole template on a second PUT', async () => {
      const first = await put(OrderMessageKind.RETURN_APPROVED, Locales.EN, {
        body: 'Return {{orderNumber}} approved',
        attachSummary: true
      })
      expect((first.body as TemplateBody).autoSend).toBe(false)
      expect((first.body as TemplateBody).attachSummary).toBe(true)

      const second = await put(OrderMessageKind.RETURN_APPROVED, Locales.EN, {
        body: 'Return approved'
      })
      expect(second.status).toBe(OK)
      expect(second.body).toMatchObject({ body: 'Return approved', attachSummary: false })
      expect(
        await owner.orderMessageTemplate.count({
          where: { storeId: ctx.storeA.id, kind: OrderMessageKind.RETURN_APPROVED, locale: 'en' }
        })
      ).toBe(1)
    })

    it('refuses a variable that does not exist and keeps what was there', async () => {
      await put(OrderMessageKind.ORDER_DELIVERED, Locales.ES, { body: 'Entregado {{orderNumber}}' })

      const response = await put(OrderMessageKind.ORDER_DELIVERED, Locales.ES, {
        body: 'Entregado {{orderNumber}} {{secret}}'
      })

      expect(response.status).toBe(BAD_REQUEST)
      expect(codeOf(response.body)).toBe(ErrorCodes.ORDER_MESSAGE_VARIABLE_UNKNOWN)
      const row = await owner.orderMessageTemplate.findFirst({
        where: { storeId: ctx.storeA.id, kind: OrderMessageKind.ORDER_DELIVERED, locale: 'es' }
      })
      expect(row?.body).toBe('Entregado {{orderNumber}}')
    })

    it.each([OrderMessageKind.ORDER_SUMMARY, OrderMessageKind.ORDER_FAILED_ATTEMPT])(
      'refuses autoSend on %s, which follows a store preference',
      async kind => {
        const response = await put(kind, Locales.ES, { body: 'x {{orderNumber}}', autoSend: true })
        expect(response.status).toBe(BAD_REQUEST)
        expect(codeOf(response.body)).toBe(ErrorCodes.VALIDATION_FAILED)
        const ok = await put(kind, Locales.ES, { body: 'x {{orderNumber}}', autoSend: false })
        expect(ok.status).toBe(OK)
      }
    )

    it('warns when an automatic template uses the scheduled delivery date, and does not when it is not automatic', async () => {
      const automatic = await put(OrderMessageKind.ORDER_OUT_FOR_DELIVERY, Locales.ES, {
        body: 'Llega el {{scheduledDeliveryDate}}',
        autoSend: true
      })
      expect((automatic.body as TemplateBody).warnings).toEqual([
        OrderMessageWarnings.AUTO_SEND_NEEDS_SCHEDULED_DATE
      ])
      const manual = await put(OrderMessageKind.ORDER_OUT_FOR_DELIVERY, Locales.ES, {
        body: 'Llega el {{scheduledDeliveryDate}}',
        autoSend: false
      })
      expect((manual.body as TemplateBody).warnings).toEqual([])
      const listed = await asAdmin().get(ApiRoutes.orderTemplates.list)
      const row = (listed.body as TemplateBody[]).find(
        item => item.kind === OrderMessageKind.ORDER_OUT_FOR_DELIVERY
      )
      expect(row?.variables).toEqual([OrderMessageVariables.SCHEDULED_DELIVERY_DATE])
    })

    it.each([
      ['a kind that does not exist', 'order_lost', 'es', { body: 'x' }],
      ['a language that is not supported', 'order_shipped', 'xx', { body: 'x' }],
      ['a blank body', 'order_shipped', 'es', { body: '  \n ' }],
      ['a body that is too long', 'order_shipped', 'es', { body: 'x'.repeat(2001) }],
      [
        'a field the template does not have',
        'order_shipped',
        'es',
        { body: 'x', storeId: 'other' }
      ],
      ['an invisible character', 'order_shipped', 'es', { body: 'x\u202Ey' }]
    ])('refuses %s', async (_name, kind, locale, body) => {
      const response = await put(kind, locale, body)
      expect(response.status).toBe(BAD_REQUEST)
      expect(codeOf(response.body)).toBe(ErrorCodes.VALIDATION_FAILED)
    })

    it('audits the creation, the change and the deletion with who did it', async () => {
      await put(OrderMessageKind.EXCHANGE_SHIPPED, Locales.EN, { body: 'Exchange sent' })
      await put(OrderMessageKind.EXCHANGE_SHIPPED, Locales.EN, { body: 'Exchange sent now' })
      await asAdmin().delete(at(OrderMessageKind.EXCHANGE_SHIPPED, Locales.EN))

      const updated = await waitForAuditEntries(
        owner,
        {
          storeId: ctx.storeA.id,
          action: AuditAction.ORDER_TEMPLATE_UPDATED,
          resourceId: 'exchange_shipped:en'
        },
        2
      )
      expect(updated.map(entry => (entry.metadata as { change: string }).change).sort()).toEqual([
        'created',
        'updated'
      ])
      expect(updated.every(entry => entry.userId === ctx.adminA.id)).toBe(true)
      const deleted = await waitForAuditEntries(owner, {
        storeId: ctx.storeA.id,
        action: AuditAction.ORDER_TEMPLATE_DELETED,
        resourceId: 'exchange_shipped:en'
      })
      expect(deleted).toHaveLength(1)
    })
  })

  describe('deleting a template', () => {
    it('removes it, and a second delete is a 404', async () => {
      await put(OrderMessageKind.ORDER_CANCELLED, Locales.EN, { body: 'Cancelled' })
      expect(
        (await asAdmin().delete(at(OrderMessageKind.ORDER_CANCELLED, Locales.EN))).status
      ).toBe(NO_CONTENT)
      expect((await asAdmin().get(at(OrderMessageKind.ORDER_CANCELLED, Locales.EN))).status).toBe(
        NOT_FOUND
      )
      expect(
        (await asAdmin().delete(at(OrderMessageKind.ORDER_CANCELLED, Locales.EN))).status
      ).toBe(NOT_FOUND)
    })
  })

  describe('the link to a channel-approved template', () => {
    const link = (pluginId: string, variables: string[] = ['customerName', 'orderNumber']) => ({
      pluginId,
      name: 'order_update',
      language: 'es',
      variables
    })

    it('stores it for a channel that declares a window asking for a template, and takes it away with null', async () => {
      const response = await put(OrderMessageKind.ORDER_SHIPPED, Locales.EN, {
        body: 'Shipped {{orderNumber}}',
        channelTemplate: link(WINDOWED, ['scheduledDeliveryDate', 'orderNumber'])
      })
      expect(response.status).toBe(OK)
      expect((response.body as TemplateBody).channelTemplate).toEqual(
        link(WINDOWED, ['scheduledDeliveryDate', 'orderNumber'])
      )
      // the variables that fill the approved template count as used, so the date warning reaches them too
      expect((response.body as TemplateBody).warnings).toEqual([
        OrderMessageWarnings.AUTO_SEND_NEEDS_SCHEDULED_DATE
      ])

      const cleared = await put(OrderMessageKind.ORDER_SHIPPED, Locales.EN, {
        body: 'Shipped {{orderNumber}}',
        channelTemplate: null
      })
      expect((cleared.body as TemplateBody).channelTemplate).toBeNull()
      const row = await owner.orderMessageTemplate.findFirst({
        where: { storeId: ctx.storeA.id, kind: OrderMessageKind.ORDER_SHIPPED, locale: 'en' }
      })
      expect(row?.channelTemplate).toBeNull()
    })

    it.each([
      ['has no window, so it sends free text at any time', NO_WINDOW],
      ['has a window but takes no templates', NO_TEMPLATES],
      ['is not a channel the store has', 'tpl_unknown']
    ])('refuses it for a channel that %s', async (_name, pluginId) => {
      const response = await put(OrderMessageKind.ORDER_SHIPPED, Locales.EN, {
        body: 'Shipped',
        channelTemplate: link(pluginId)
      })
      expect(response.status).toBe(CONFLICT)
      expect(codeOf(response.body)).toBe(ErrorCodes.CHANNEL_CAPABILITY_UNSUPPORTED)
      // Refused as a whole: no row was written with the link
      expect(
        await owner.orderMessageTemplate.count({
          where: {
            storeId: ctx.storeA.id,
            channelTemplate: { path: ['pluginId'], equals: pluginId }
          }
        })
      ).toBe(0)
    })

    describe('when the store has an account of the channel', () => {
      const approved = {
        name: 'order_update',
        language: 'es',
        status: TemplateStatuses.APPROVED,
        body: 'Hola'
      }
      const save = () =>
        put(OrderMessageKind.ORDER_SHIPPED, Locales.EN, {
          body: 'Shipped',
          channelTemplate: link(WINDOWED)
        })
      const stored = () =>
        owner.orderMessageTemplate.count({
          where: {
            storeId: ctx.storeA.id,
            channelTemplate: { path: ['pluginId'], equals: WINDOWED }
          }
        })
      const connect = async () => {
        const row = await createChannelConnection(owner, {
          storeId: ctx.storeA.id,
          channelType: WINDOWED
        })
        // The channel is asked with the credentials of the connection: they must open, as a real one's do
        await owner.channelConnection.update({
          where: { id: row.id },
          data: {
            credentials: app.get(CredentialCipher, { strict: false }).seal({ token: 'test' })
          }
        })
      }
      beforeEach(async () => {
        listed = []
        listingFails = false
        await owner.orderMessageTemplate.deleteMany({ where: { storeId: ctx.storeA.id } })
        await connect()
      })
      afterEach(async () => {
        listingFails = false
        await owner.channelConnection.deleteMany({
          where: { storeId: ctx.storeA.id, pluginId: WINDOWED }
        })
      })

      it('saves a link to a template the channel approved', async () => {
        listed = [approved]
        expect((await save()).status).toBe(OK)
      })

      it('refuses a template the channel does not list, with its own code, and writes nothing', async () => {
        listed = [{ ...approved, name: 'another_one' }]
        const response = await save()
        expect(response.status).toBe(BAD_REQUEST)
        expect(codeOf(response.body)).toBe(ErrorCodes.ORDER_TEMPLATE_CHANNEL_TEMPLATE_MISSING)
        expect(await stored()).toBe(0)
      })

      it('refuses the right name in another language', async () => {
        listed = [{ ...approved, language: 'en' }]
        expect(codeOf((await save()).body)).toBe(ErrorCodes.ORDER_TEMPLATE_CHANNEL_TEMPLATE_MISSING)
      })

      it('refuses a template that is listed but not approved', async () => {
        listed = [{ ...approved, status: TemplateStatuses.PENDING }]
        const response = await save()
        expect(response.status).toBe(BAD_REQUEST)
        expect(codeOf(response.body)).toBe(ErrorCodes.ORDER_TEMPLATE_CHANNEL_TEMPLATE_NOT_APPROVED)
        expect(await stored()).toBe(0)
      })

      it('saves anyway when the channel does not answer: it is judged when the message goes', async () => {
        listingFails = true
        expect((await save()).status).toBe(OK)
      })

      it('does not ask again for a link that is already stored, so the text can still be edited', async () => {
        listed = [approved]
        expect((await save()).status).toBe(OK)
        // The channel has since lost the template: the same link still saves with a new body
        listed = []
        const edited = await put(OrderMessageKind.ORDER_SHIPPED, Locales.EN, {
          body: 'Shipped, new text',
          channelTemplate: link(WINDOWED)
        })
        expect(edited.status).toBe(OK)
        // A different template is asked
        const other = await put(OrderMessageKind.ORDER_SHIPPED, Locales.EN, {
          body: 'Shipped',
          channelTemplate: { ...link(WINDOWED), name: 'another_one' }
        })
        expect(codeOf(other.body)).toBe(ErrorCodes.ORDER_TEMPLATE_CHANNEL_TEMPLATE_MISSING)
      })

      it('does not ask the accounts of another store', async () => {
        await owner.channelConnection.deleteMany({
          where: { storeId: ctx.storeA.id, pluginId: WINDOWED }
        })
        const other = await createChannelConnection(owner, {
          storeId: ctx.storeB.id,
          channelType: WINDOWED
        })
        await owner.channelConnection.update({
          where: { id: other.id },
          data: { credentials: app.get(CredentialCipher, { strict: false }).seal({ token: 'x' }) }
        })
        listed = []
        try {
          // Store A has no account of its own: nothing to compare with, so the link is saved
          expect((await save()).status).toBe(OK)
        } finally {
          await owner.channelConnection.deleteMany({ where: { id: other.id } })
        }
      })
    })

    it('refuses a variable of the link that is not in the allowlist, or more variables than a template can take', async () => {
      const unknown = await put(OrderMessageKind.ORDER_SHIPPED, Locales.EN, {
        body: 'Shipped',
        channelTemplate: link(WINDOWED, ['secret'])
      })
      expect(unknown.status).toBe(BAD_REQUEST)
      const many = await put(OrderMessageKind.ORDER_SHIPPED, Locales.EN, {
        body: 'Shipped',
        channelTemplate: link(WINDOWED, Array<string>(11).fill('orderNumber'))
      })
      expect(many.status).toBe(BAD_REQUEST)
    })
  })

  describe('previewing', () => {
    it('renders the body being edited with a sample order, in the language asked', async () => {
      const response = await asAdmin()
        .post(ApiRoutes.orderTemplates.preview)
        .send({ body: 'Hola {{customerName}}: {{itemsList}}', locale: Locales.ES })
      expect(response.status).toBe(OK)
      const preview = response.body as { text: string; variables: string[] }
      expect(preview.text).toContain('María López')
      expect(preview.text).toContain('Zapatos deportivos')
      expect(preview.variables).toEqual(['customerName', 'itemsList'])
    })

    it('refuses what saving would refuse, and writes nothing', async () => {
      const before = await owner.orderMessageTemplate.count({ where: { storeId: ctx.storeA.id } })
      const response = await asAdmin()
        .post(ApiRoutes.orderTemplates.preview)
        .send({ body: '{{secret}}', locale: Locales.ES })
      expect(response.status).toBe(BAD_REQUEST)
      expect(codeOf(response.body)).toBe(ErrorCodes.ORDER_MESSAGE_VARIABLE_UNKNOWN)
      expect(await owner.orderMessageTemplate.count({ where: { storeId: ctx.storeA.id } })).toBe(
        before
      )
    })
  })

  describe('who may', () => {
    it('lets whoever sees orders read, and only the permission to manage templates write, delete or preview', async () => {
      await put(OrderMessageKind.ORDER_SHIPPED, Locales.ES, { body: 'original {{orderNumber}}' })
      const asReader = () => api(app, reader, ctx.storeA)
      expect((await asReader().get(ApiRoutes.orderTemplates.list)).status).toBe(OK)
      expect((await asReader().get(at(OrderMessageKind.ORDER_SHIPPED, Locales.ES))).status).toBe(OK)
      const attempts = [
        asReader().put(at(OrderMessageKind.ORDER_SHIPPED, Locales.ES)).send({ body: 'x' }),
        asReader().delete(at(OrderMessageKind.ORDER_SHIPPED, Locales.ES)),
        asReader().post(ApiRoutes.orderTemplates.preview).send({ body: 'x', locale: 'es' }),
        api(app, ctx.agentA, ctx.storeA)
          .put(at(OrderMessageKind.ORDER_SHIPPED, Locales.ES))
          .send({ body: 'x' })
      ]
      for (const attempt of attempts) {
        const response = await attempt
        expect(response.status).toBe(FORBIDDEN)
        expect(codeOf(response.body)).toBe(ErrorCodes.PERMISSION_DENIED)
      }
      const row = await owner.orderMessageTemplate.findFirst({
        where: { storeId: ctx.storeA.id, kind: OrderMessageKind.ORDER_SHIPPED, locale: 'es' }
      })
      expect(row?.body).toBe('original {{orderNumber}}')
    })
  })

  describe('one store never sees or changes the templates of another', () => {
    it('lists, reads, writes and deletes only its own, with the same kind and language in both', async () => {
      const kind = OrderMessageKind.ORDER_OUT_FOR_DELIVERY
      await createOrderMessageTemplate(owner, {
        storeId: ctx.storeB.id,
        kind: OrderMessageKind.RETURN_APPROVED,
        locale: Locales.ES,
        body: 'Only B'
      })
      await put(kind, Locales.EN, { body: 'A says {{orderNumber}}' })

      const listedByB = await asAdminB().get(ApiRoutes.orderTemplates.list)
      const bodiesOfB = (listedByB.body as TemplateBody[]).map(item => item.body)
      expect(bodiesOfB).toContain('Only B')
      expect(bodiesOfB.some(body => body.startsWith('A says'))).toBe(false)
      expect((await asAdminB().get(at(kind, Locales.EN))).status).toBe(NOT_FOUND)
      expect((await asAdminB().delete(at(kind, Locales.EN))).status).toBe(NOT_FOUND)

      const written = await asAdminB()
        .put(at(kind, Locales.EN))
        .send({ body: 'B says {{orderNumber}}' })
      expect(written.status).toBe(OK)
      const rowA = await owner.orderMessageTemplate.findFirst({
        where: { storeId: ctx.storeA.id, kind, locale: 'en' }
      })
      expect(rowA?.body).toBe('A says {{orderNumber}}')
    })
  })

  describe('finding the template of a message (what the sender reads)', () => {
    it('takes the language of the customer, then the default of the store, then none', async () => {
      const service = app.get(OrderTemplatesService, { strict: false })
      const kind = OrderMessageKind.EXCHANGE_SHIPPED
      const before = await owner.store.findUniqueOrThrow({
        where: { id: ctx.storeA.id },
        select: { defaultLocale: true }
      })
      await owner.store.update({ where: { id: ctx.storeA.id }, data: { defaultLocale: 'es' } })
      await put(kind, Locales.ES, { body: 'Cambio enviado' })
      expect((await service.resolve(ctx.storeA.id, kind, 'en'))?.body).toBe('Cambio enviado')
      await put(kind, Locales.EN, { body: 'Exchange sent' })
      expect((await service.resolve(ctx.storeA.id, kind, 'en'))?.body).toBe('Exchange sent')
      expect((await service.resolve(ctx.storeA.id, kind, null))?.body).toBe('Cambio enviado')
      expect((await service.resolve(ctx.storeA.id, kind, 'pt-BR'))?.body).toBe('Cambio enviado')
      expect(await service.resolve(ctx.storeB.id, kind, 'es')).toBeNull()
      await owner.store.update({
        where: { id: ctx.storeA.id },
        data: { defaultLocale: before.defaultLocale }
      })
    })
  })
})
