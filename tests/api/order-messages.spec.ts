import { randomUUID } from 'node:crypto'

import { getQueueToken } from '@nestjs/bullmq'
import type { INestApplication } from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import { AuditAction } from '@platform/core/audit'
import { Permissions } from '@platform/core/auth'
import { ConsentPurposes, LegalBases } from '@platform/core/compliance'
import { CredentialCipher } from '@platform/core/crypto'
import { DatabaseNull } from '@platform/core/database'
import type { OwnerClient } from '@platform/core/database-testing'
import {
  AuthorType,
  ConversationStatus,
  DeliveryStatus,
  MessageType,
  OrderMessageKind,
  type OrderMessageKindType,
  OrderMessageNotSentReasons,
  OrderMessageOutcomeStatus,
  OrderMessageRoutes,
  OrderMessageTriggers
} from '@platform/core/domain'
import { Locales } from '@platform/core/i18n'
import { NotificationTypes } from '@platform/core/notifications'
import { EmailTemplates, QueueNames } from '@platform/core/queues'
import { automaticDispatchKey } from '@platform/core/shipping'
import { PluginRegistry } from '@platform/plugins/runtime'
import { ChannelCapability, type MessageTemplate } from '@platform/plugins/sdk'

import { OrderMessagesService } from '../../apps/api/src/modules/order-messages/order-messages.service'
import {
  buildChannelPlugin,
  createCarrierConnection,
  createConversation,
  createCustomerIdentity,
  createMessageOf,
  createOrder
} from '../builders'
import { actorWithPermissions } from '../helpers/actors'
import { createTestApp } from '../helpers/app'
import { waitForAuditEntries } from '../helpers/audit'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { emailsOf } from '../helpers/email'
import { api } from '../helpers/http'
import { CapturedQueue } from '../helpers/queue'

const OK = 200
const FORBIDDEN = 403
const NOT_FOUND = 404
const BAD_REQUEST = 400
const HOUR_MS = 60 * 60 * 1000
const WAIT_ATTEMPTS = 40
const WAIT_MS = 50

// The three answers of a declaration, never the name of a plugin (rule 13): a window that asks for an approved template when it
// is closed, a channel that declares no window at all, and the same window with no template capability
const WINDOWED = 'om_windowed'
const NO_WINDOW = 'om_no_window'
const NO_TEMPLATES = 'om_no_templates'
// A channel that declares no window and takes little text
const SMALL = 'om_small'

const APPROVED: MessageTemplate = {
  name: 'order_update',
  language: 'es',
  status: 'approved',
  body: 'Pedido {{1}} en camino'
}

interface MessageOutcomeBody {
  status: string
  route?: string
  reason?: string
  messageId?: string | null
}

// Sending the messages of an order (TDD_17 §4.7, Step 4.9 PR C2a): the decision of the window by what the channel declares, the
// email fallback, the reasons that stop a message, the idempotency of a send and the route a person sends by hand.
describe('Order messages', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  let service: OrderMessagesService
  let sender: Awaited<ReturnType<typeof actorWithPermissions>>
  let viewer: Awaited<ReturnType<typeof actorWithPermissions>>
  let listed: MessageTemplate[] = [APPROVED]
  // The provider does not answer when asked for its templates
  let listingFails = false
  const outbound = new CapturedQueue()
  const pushQueue = new CapturedQueue()

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp([], builder =>
      builder
        .overrideProvider(getQueueToken(QueueNames.OUTBOUND))
        .useValue(outbound)
        .overrideProvider(getQueueToken(QueueNames.NOTIFICATIONS))
        .useValue(pushQueue)
    )
    ctx = await seedTestContext(owner, app, prefix)
    service = app.get(OrderMessagesService)
    const registry = app.get(PluginRegistry, { strict: false })
    const withTemplates = [ChannelCapability.TEXT, ChannelCapability.TEMPLATES]
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
    registry.register(
      buildChannelPlugin({
        id: SMALL,
        capabilities: [ChannelCapability.TEXT],
        limits: { textMaxLength: 20 },
        messagingWindow: null
      })
    )
    sender = await actorWithPermissions(owner, app, {
      prefix,
      name: 'orderMessageSender',
      organizationId: ctx.orgA.id,
      storeId: ctx.storeA.id,
      permissions: [Permissions.ORDERS_VIEW, Permissions.ORDERS_SEND_MESSAGES]
    })
    viewer = await actorWithPermissions(owner, app, {
      prefix,
      name: 'orderMessageViewer',
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
  beforeEach(async () => {
    // Each case builds the templates it needs: a template left by another one would answer for it
    await owner.orderMessageTemplate.deleteMany({
      where: { storeId: { in: [ctx.storeA.id, ctx.storeB.id] } }
    })
    listed = [APPROVED]
    listingFails = false
    outbound.jobs.length = 0
    emailsOf(app).clear()
  })

  interface Scene {
    orderId: string
    customerId: string
    conversationId: string | null
    storeId: string
  }

  // An order of the store A with its customer, and a conversation of that customer over a channel
  async function scene(options: {
    channel?: string | null
    // How long ago the customer last wrote; null never
    wroteHoursAgo?: number | null
    email?: string | null
    locale?: string | null
    status?: ConversationStatus
    scheduledDeliveryDate?: Date | null
    ownConversation?: boolean
  }): Promise<Scene> {
    const order = await createOrder(owner, {
      storeId: ctx.storeA.id,
      status: 'CONFIRMED',
      shippingAddress: { line1: '1 Main St', city: 'San Salvador', country: 'SV' },
      ...(options.scheduledDeliveryDate === undefined
        ? {}
        : { scheduledDeliveryDate: options.scheduledDeliveryDate })
    })
    const row = await owner.order.findFirstOrThrow({
      where: { id: order.id },
      select: { customerId: true }
    })
    await owner.customer.update({
      where: { id: row.customerId },
      data: {
        name: 'Ana',
        email: options.email === undefined ? null : options.email,
        locale: options.locale === undefined ? null : options.locale
      }
    })
    let conversationId: string | null = null
    if (options.channel !== null && options.channel !== undefined) {
      const hours = options.wroteHoursAgo === undefined ? 1 : options.wroteHoursAgo
      const identity = await createCustomerIdentity(owner, {
        storeId: ctx.storeA.id,
        customerId: row.customerId,
        channelType: options.channel
      })
      await owner.customerIdentity.update({
        where: { id: identity.id },
        data: { lastInboundAt: hours === null ? null : new Date(Date.now() - hours * HOUR_MS) }
      })
      const conversation = await createConversation(owner, {
        storeId: ctx.storeA.id,
        customerId: row.customerId,
        customerIdentityId: identity.id,
        channelType: options.channel,
        ...(options.status === undefined ? {} : { status: options.status })
      })
      conversationId = conversation.id
      // The channel is asked for its templates with the credentials of the connection: they must open, as a real one's do
      await owner.channelConnection.updateMany({
        where: { conversations: { some: { id: conversation.id } } },
        data: { credentials: app.get(CredentialCipher, { strict: false }).seal({ token: 'test' }) }
      })
      if (options.ownConversation !== false) {
        await owner.order.update({ where: { id: order.id }, data: { conversationId } })
      }
    }
    return { orderId: order.id, customerId: row.customerId, conversationId, storeId: ctx.storeA.id }
  }

  // One template per kind and language in a store: asking for the same one again replaces it
  const template = (
    kind: OrderMessageKindType,
    body: string,
    extra: { channelTemplate?: object; locale?: string; storeId?: string } = {}
  ) => {
    const where = {
      storeId_kind_locale: {
        storeId: extra.storeId ?? ctx.storeA.id,
        kind,
        locale: extra.locale ?? Locales.ES
      }
    }
    const data = {
      body,
      channelTemplate: extra.channelTemplate ?? DatabaseNull
    }
    return owner.orderMessageTemplate.upsert({
      where,
      create: { ...where.storeId_kind_locale, ...data },
      update: data
    })
  }
  const link = (pluginId: string, variables: string[] = ['orderNumber']) => ({
    pluginId,
    name: APPROVED.name,
    language: APPROVED.language,
    variables
  })

  let counter = 0
  const send = (
    scenario: Scene,
    kind: OrderMessageKindType = OrderMessageKind.ORDER_SHIPPED,
    key = automaticDispatchKey(`s-${scenario.orderId}`, 'DELIVERED', kind, (counter += 1))
  ) =>
    service.send({
      storeId: scenario.storeId,
      orderId: scenario.orderId,
      kind,
      trigger: OrderMessageTriggers.AUTOMATIC,
      idempotencyKey: key,
      requestedBy: null
    })

  const messagesOf = (conversationId: string | null) =>
    owner.message.findMany({ where: { conversationId: conversationId ?? '' } })
  const dispatchesOf = (orderId: string) =>
    owner.orderMessageDispatch.findMany({ where: { orderId } })
  async function eventually<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
    let value = await read()
    for (let attempt = 0; attempt < WAIT_ATTEMPTS && !done(value); attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, WAIT_MS))
      value = await read()
    }
    return value
  }
  // A notice is written by a listener after the answer: the absence of one is only proven by waiting the whole window for it
  async function expectNoAlert(orderId: string): Promise<void> {
    const rows = await eventually(
      () => noticesOf(orderId),
      found => found.length > 0
    )
    expect(rows).toHaveLength(0)
  }
  const noticesOf = (orderId: string) =>
    owner.notification.findMany({
      where: {
        storeId: ctx.storeA.id,
        type: NotificationTypes.ORDER_MESSAGE_NOT_SENT,
        resourceId: orderId
      }
    })

  describe('a channel that declares no window', () => {
    it('sends free text at any time as an outbound message of the system, and keeps one row of what it did', async () => {
      await template(
        OrderMessageKind.ORDER_SHIPPED,
        'Hola {{customerName}}, el pedido {{orderNumber}} va en camino'
      )
      const scenario = await scene({ channel: NO_WINDOW, wroteHoursAgo: 500 })

      const outcome = await send(scenario)

      expect(outcome).toMatchObject({
        status: OrderMessageOutcomeStatus.SENT,
        route: OrderMessageRoutes.CHANNEL_TEXT
      })
      const messages = await messagesOf(scenario.conversationId)
      expect(messages).toHaveLength(1)
      expect(messages[0]).toMatchObject({
        type: MessageType.TEXT,
        authorType: AuthorType.SYSTEM,
        deliveryStatus: DeliveryStatus.QUEUED,
        authorId: null
      })
      expect(messages[0]?.content).toMatch(/^Hola Ana, el pedido T-.{8} va en camino$/)
      expect(outbound.jobs.map(job => job.data)).toContainEqual({
        storeId: ctx.storeA.id,
        messageId: messages[0]?.id
      })
      const [row] = await dispatchesOf(scenario.orderId)
      expect(row).toMatchObject({
        kind: OrderMessageKind.ORDER_SHIPPED,
        trigger: OrderMessageTriggers.AUTOMATIC,
        route: OrderMessageRoutes.CHANNEL_TEXT,
        reason: null,
        messageId: messages[0]?.id
      })
    })

    it('ignores a linked approved template: the link is not used for a channel that declares no window', async () => {
      await template(OrderMessageKind.ORDER_DELIVERED, 'Entregado {{orderNumber}}', {
        channelTemplate: link(NO_WINDOW)
      })
      const scenario = await scene({ channel: NO_WINDOW, wroteHoursAgo: 500 })

      const outcome = await send(scenario, OrderMessageKind.ORDER_DELIVERED)

      expect(outcome).toMatchObject({
        status: OrderMessageOutcomeStatus.SENT,
        route: OrderMessageRoutes.CHANNEL_TEXT
      })
      expect((await messagesOf(scenario.conversationId))[0]?.type).toBe(MessageType.TEXT)
    })
  })

  describe('a channel with a window', () => {
    it('sends free text inside the window', async () => {
      await template(OrderMessageKind.ORDER_OUT_FOR_DELIVERY, 'En ruta {{orderNumber}}')
      const scenario = await scene({ channel: WINDOWED, wroteHoursAgo: 2 })

      const outcome = await send(scenario, OrderMessageKind.ORDER_OUT_FOR_DELIVERY)

      expect(outcome).toMatchObject({
        status: OrderMessageOutcomeStatus.SENT,
        route: OrderMessageRoutes.CHANNEL_TEXT
      })
    })

    it('sends the approved template, its variables in order, outside the window', async () => {
      await template(OrderMessageKind.ORDER_SUMMARY, 'Resumen {{orderNumber}} de {{storeName}}', {
        channelTemplate: link(WINDOWED, ['orderNumber'])
      })
      const scenario = await scene({ channel: WINDOWED, wroteHoursAgo: 48 })

      const outcome = await send(scenario, OrderMessageKind.ORDER_SUMMARY)

      expect(outcome).toMatchObject({
        status: OrderMessageOutcomeStatus.SENT,
        route: OrderMessageRoutes.CHANNEL_TEMPLATE
      })
      const [message] = await messagesOf(scenario.conversationId)
      expect(message).toMatchObject({ type: MessageType.TEMPLATE, authorType: AuthorType.SYSTEM })
      expect(message?.content).toMatch(/^Pedido T-.{8} en camino$/)
      expect(message?.metadata).toMatchObject({
        template: {
          name: 'order_update',
          language: 'es',
          variables: [expect.stringMatching(/^T-/)]
        },
        orderMessage: { kind: OrderMessageKind.ORDER_SUMMARY }
      })
    })

    it('falls back to email outside the window when no template is linked', async () => {
      await template(OrderMessageKind.ORDER_CANCELLED, 'Cancelado {{orderNumber}}')
      const scenario = await scene({
        channel: WINDOWED,
        wroteHoursAgo: 48,
        email: 'ana@example.com'
      })

      const outcome = await send(scenario, OrderMessageKind.ORDER_CANCELLED)

      expect(outcome).toMatchObject({
        status: OrderMessageOutcomeStatus.SENT,
        route: OrderMessageRoutes.EMAIL,
        messageId: null
      })
      expect(await messagesOf(scenario.conversationId)).toHaveLength(0)
      const [job] = emailsOf(app).to('ana@example.com')
      expect(job).toMatchObject({
        template: EmailTemplates.ORDER_MESSAGE,
        locale: 'es',
        tags: { storeId: ctx.storeA.id, template: EmailTemplates.ORDER_MESSAGE }
      })
      expect((job?.data as { text: string }).text).toMatch(/^Cancelado T-/)
    })

    it('falls back to email when the linked template is not approved', async () => {
      listed = [{ ...APPROVED, status: 'pending' }]
      await template(OrderMessageKind.ORDER_SHIPPED, 'Va {{orderNumber}}', {
        channelTemplate: link(WINDOWED)
      })
      const scenario = await scene({
        channel: WINDOWED,
        wroteHoursAgo: 48,
        email: 'ben@example.com'
      })

      const outcome = await send(scenario)

      expect(outcome).toMatchObject({
        status: OrderMessageOutcomeStatus.SENT,
        route: OrderMessageRoutes.EMAIL
      })
      expect(await messagesOf(scenario.conversationId)).toHaveLength(0)
    })

    it('tells by email when the approved template needs a value the order lacks and the text does not', async () => {
      await template(OrderMessageKind.ORDER_SHIPPED, 'Va {{orderNumber}}', {
        channelTemplate: link(WINDOWED, ['scheduledDeliveryDate'])
      })
      const scenario = await scene({
        channel: WINDOWED,
        wroteHoursAgo: 48,
        email: 'late@example.com',
        scheduledDeliveryDate: null
      })

      expect(await send(scenario)).toMatchObject({
        status: OrderMessageOutcomeStatus.SENT,
        route: OrderMessageRoutes.EMAIL
      })
    })

    it('claims nothing and throws when the provider cannot be asked, so the message is sent when it is asked again', async () => {
      await template(OrderMessageKind.ORDER_SHIPPED, 'Va {{orderNumber}}', {
        channelTemplate: link(WINDOWED)
      })
      const scenario = await scene({
        channel: WINDOWED,
        wroteHoursAgo: 48,
        email: 'blip@example.com'
      })
      const key = automaticDispatchKey('ship-blip', 'PICKED_UP', OrderMessageKind.ORDER_SHIPPED)
      listingFails = true

      await expect(send(scenario, OrderMessageKind.ORDER_SHIPPED, key)).rejects.toThrow()
      expect(await dispatchesOf(scenario.orderId)).toHaveLength(0)
      expect(emailsOf(app).jobs).toHaveLength(0)

      listingFails = false
      expect(await send(scenario, OrderMessageKind.ORDER_SHIPPED, key)).toMatchObject({
        status: OrderMessageOutcomeStatus.SENT,
        route: OrderMessageRoutes.CHANNEL_TEMPLATE
      })
    })

    it('is not sent, with the reason, when the window is closed and nothing else is left, and the team is told', async () => {
      await template(OrderMessageKind.ORDER_DELIVERED, 'Entregado {{orderNumber}}')
      const scenario = await scene({ channel: WINDOWED, wroteHoursAgo: 48 })

      const outcome = await send(scenario, OrderMessageKind.ORDER_DELIVERED)

      expect(outcome).toEqual({
        status: OrderMessageOutcomeStatus.NOT_SENT,
        reason: OrderMessageNotSentReasons.WINDOW_CLOSED
      })
      expect(await messagesOf(scenario.conversationId)).toHaveLength(0)
      expect(emailsOf(app).jobs).toHaveLength(0)
      const [row] = await dispatchesOf(scenario.orderId)
      expect(row).toMatchObject({
        route: OrderMessageRoutes.NOT_SENT,
        reason: OrderMessageNotSentReasons.WINDOW_CLOSED,
        messageId: null
      })
      const notices = await eventually(
        () => noticesOf(scenario.orderId),
        rows => rows.length > 0
      )
      expect(notices.map(notice => notice.userId)).toContain(ctx.adminA.id)
      expect(notices.map(notice => notice.userId)).not.toContain(viewer.id)
      const entries = await waitForAuditEntries(owner, {
        storeId: ctx.storeA.id,
        action: AuditAction.ORDER_MESSAGE_NOT_SENT,
        resourceId: scenario.orderId
      })
      expect(entries[0]?.metadata).toMatchObject({
        reason: OrderMessageNotSentReasons.WINDOW_CLOSED
      })
    })

    it('names the template as the reason when it was linked but cannot be used', async () => {
      listed = []
      await template(OrderMessageKind.ORDER_SHIPPED, 'Va {{orderNumber}}', {
        channelTemplate: link(WINDOWED)
      })
      const scenario = await scene({ channel: WINDOWED, wroteHoursAgo: 48 })

      expect(await send(scenario)).toEqual({
        status: OrderMessageOutcomeStatus.NOT_SENT,
        reason: OrderMessageNotSentReasons.TEMPLATE_UNAVAILABLE
      })
    })

    it('does not use the link of another plugin, nor one for a plugin that declares no templates', async () => {
      await template(OrderMessageKind.ORDER_OUT_FOR_DELIVERY, 'En ruta {{orderNumber}}', {
        channelTemplate: link(NO_WINDOW)
      })
      const elsewhere = await scene({
        channel: WINDOWED,
        wroteHoursAgo: 48,
        email: 'c@example.com'
      })
      expect(await send(elsewhere, OrderMessageKind.ORDER_OUT_FOR_DELIVERY)).toMatchObject({
        route: OrderMessageRoutes.EMAIL
      })
      await template(OrderMessageKind.ORDER_FAILED_ATTEMPT, 'Intento {{orderNumber}}')
      const bare = await scene({ channel: NO_TEMPLATES, wroteHoursAgo: 48 })
      expect(await send(bare, OrderMessageKind.ORDER_FAILED_ATTEMPT)).toEqual({
        status: OrderMessageOutcomeStatus.NOT_SENT,
        reason: OrderMessageNotSentReasons.WINDOW_CLOSED
      })
    })
  })

  describe('the conversation', () => {
    it('goes by email when the order has no conversation and the customer has an address', async () => {
      await template(OrderMessageKind.ORDER_SHIPPED, 'Va {{orderNumber}}')
      const scenario = await scene({ channel: null, email: 'solo@example.com' })

      expect(await send(scenario)).toMatchObject({
        status: OrderMessageOutcomeStatus.SENT,
        route: OrderMessageRoutes.EMAIL
      })
    })

    it('is not sent when there is no conversation and no address', async () => {
      await template(OrderMessageKind.ORDER_SHIPPED, 'Va {{orderNumber}}')
      const scenario = await scene({ channel: null })

      expect(await send(scenario)).toEqual({
        status: OrderMessageOutcomeStatus.NOT_SENT,
        reason: OrderMessageNotSentReasons.NO_CHANNEL
      })
    })

    it('uses the most recent open conversation of the customer when the order has none of its own', async () => {
      await template(OrderMessageKind.ORDER_SHIPPED, 'Va {{orderNumber}}')
      const scenario = await scene({ channel: NO_WINDOW, ownConversation: false })

      expect(await send(scenario)).toMatchObject({
        status: OrderMessageOutcomeStatus.SENT,
        route: OrderMessageRoutes.CHANNEL_TEXT
      })
      expect(await messagesOf(scenario.conversationId)).toHaveLength(1)
    })

    it('skips a spam conversation and a channel whose plugin is not registered, and takes the email', async () => {
      await template(OrderMessageKind.ORDER_SHIPPED, 'Va {{orderNumber}}')
      const spam = await scene({
        channel: NO_WINDOW,
        status: ConversationStatus.SPAM,
        email: 's@example.com'
      })
      expect(await send(spam)).toMatchObject({ route: OrderMessageRoutes.EMAIL })
      expect(await messagesOf(spam.conversationId)).toHaveLength(0)
      const gone = await scene({ channel: 'om_unregistered', email: 'g@example.com' })
      expect(await send(gone)).toMatchObject({ route: OrderMessageRoutes.EMAIL })
    })
  })

  describe('what stops a message', () => {
    it('is not sent when the store has no template of the kind, and the team is told', async () => {
      const scenario = await scene({ channel: NO_WINDOW })

      expect(await send(scenario, OrderMessageKind.RETURN_APPROVED)).toEqual({
        status: OrderMessageOutcomeStatus.NOT_SENT,
        reason: OrderMessageNotSentReasons.NO_TEMPLATE
      })
      expect(
        (
          await eventually(
            () => noticesOf(scenario.orderId),
            rows => rows.length > 0
          )
        ).length
      ).toBeGreaterThan(0)
    })

    it('uses the template of the customer language, then the one of the store', async () => {
      await template(OrderMessageKind.EXCHANGE_SHIPPED, 'Hola {{orderNumber}}')
      await template(OrderMessageKind.EXCHANGE_SHIPPED, 'Hello {{orderNumber}}', {
        locale: Locales.EN
      })
      const english = await scene({ channel: NO_WINDOW, locale: 'en' })
      await send(english, OrderMessageKind.EXCHANGE_SHIPPED)
      expect((await messagesOf(english.conversationId))[0]?.content).toMatch(/^Hello /)
      const other = await scene({ channel: NO_WINDOW, locale: 'pt-BR' })
      await send(other, OrderMessageKind.EXCHANGE_SHIPPED)
      expect((await messagesOf(other.conversationId))[0]?.content).toMatch(/^Hola /)
    })

    it('does not send a variable with no value, nor fall back to email with the same hole', async () => {
      await template(OrderMessageKind.ORDER_OUT_FOR_DELIVERY, 'Llega el {{scheduledDeliveryDate}}')
      const scenario = await scene({
        channel: NO_WINDOW,
        email: 'm@example.com',
        scheduledDeliveryDate: null
      })

      expect(await send(scenario, OrderMessageKind.ORDER_OUT_FOR_DELIVERY)).toEqual({
        status: OrderMessageOutcomeStatus.NOT_SENT,
        reason: OrderMessageNotSentReasons.MISSING_VARIABLE
      })
      expect(emailsOf(app).jobs).toHaveLength(0)
      expect(await messagesOf(scenario.conversationId)).toHaveLength(0)
    })

    it('sends the date of a scheduled delivery when the order has one', async () => {
      await template(OrderMessageKind.ORDER_SHIPPED, 'Llega el {{scheduledDeliveryDate}}', {
        locale: Locales.ES
      })
      const scenario = await scene({
        channel: NO_WINDOW,
        scheduledDeliveryDate: new Date('2026-10-28T00:00:00.000Z')
      })

      await send(scenario)

      expect((await messagesOf(scenario.conversationId))[0]?.content).toBe(
        'Llega el miércoles 28 de octubre'
      )
    })

    it('does not write to a customer who was erased, records it and raises no alert', async () => {
      await template(OrderMessageKind.ORDER_SHIPPED, 'Va {{orderNumber}}')
      const scenario = await scene({ channel: NO_WINDOW, email: 'e@example.com' })
      await owner.customer.update({
        where: { id: scenario.customerId },
        data: { erasedAt: new Date() }
      })

      expect(await send(scenario)).toEqual({
        status: OrderMessageOutcomeStatus.NOT_SENT,
        reason: OrderMessageNotSentReasons.CUSTOMER_ERASED
      })
      expect(await messagesOf(scenario.conversationId)).toHaveLength(0)
      expect(emailsOf(app).jobs).toHaveLength(0)
      expect((await dispatchesOf(scenario.orderId))[0]?.reason).toBe(
        OrderMessageNotSentReasons.CUSTOMER_ERASED
      )
      await expectNoAlert(scenario.orderId)
    })

    it('does not write to a customer who withdrew their consent to order messages, and writes again when it is granted back', async () => {
      await template(OrderMessageKind.ORDER_SHIPPED, 'Va {{orderNumber}}')
      const scenario = await scene({ channel: NO_WINDOW })
      const record = (granted: boolean, at: Date) =>
        owner.consentRecord.create({
          data: {
            storeId: ctx.storeA.id,
            customerId: scenario.customerId,
            purpose: ConsentPurposes.ORDER_MESSAGES,
            legalBasis: LegalBases.CONTRACT,
            granted,
            ...(granted ? { grantedAt: at } : { revokedAt: at }),
            source: 'test',
            createdAt: at
          }
        })
      await record(false, new Date(Date.now() - HOUR_MS))

      expect(await send(scenario)).toEqual({
        status: OrderMessageOutcomeStatus.NOT_SENT,
        reason: OrderMessageNotSentReasons.CONSENT_REVOKED
      })
      await expectNoAlert(scenario.orderId)

      await record(true, new Date())
      expect(await send(scenario)).toMatchObject({ status: OrderMessageOutcomeStatus.SENT })
    })

    it('does not take a consent of another purpose, nor one of another customer, for a refusal', async () => {
      await template(OrderMessageKind.ORDER_SHIPPED, 'Va {{orderNumber}}')
      const scenario = await scene({ channel: NO_WINDOW })
      const stranger = await scene({ channel: NO_WINDOW })
      await owner.consentRecord.create({
        data: {
          storeId: ctx.storeA.id,
          customerId: scenario.customerId,
          purpose: 'marketing',
          legalBasis: LegalBases.CONSENT,
          granted: false,
          source: 'test'
        }
      })
      await owner.consentRecord.create({
        data: {
          storeId: ctx.storeA.id,
          customerId: stranger.customerId,
          purpose: ConsentPurposes.ORDER_MESSAGES,
          legalBasis: LegalBases.CONTRACT,
          granted: false,
          source: 'test'
        }
      })

      expect(await send(scenario)).toMatchObject({ status: OrderMessageOutcomeStatus.SENT })
    })
  })

  describe('what the channel holds', () => {
    it('tells a customer with an address by email when the text is longer than the channel holds', async () => {
      await template(
        OrderMessageKind.ORDER_SHIPPED,
        'Un texto que no cabe en la ventana {{orderNumber}}'
      )
      const scenario = await scene({ channel: SMALL, email: 'long@example.com' })

      expect(await send(scenario)).toMatchObject({
        status: OrderMessageOutcomeStatus.SENT,
        route: OrderMessageRoutes.EMAIL
      })
      expect(await messagesOf(scenario.conversationId)).toHaveLength(0)
    })

    it('is not sent, as too long, when the customer has no address either', async () => {
      await template(
        OrderMessageKind.ORDER_SHIPPED,
        'Un texto que no cabe en la ventana {{orderNumber}}'
      )
      const scenario = await scene({ channel: SMALL })

      expect(await send(scenario)).toEqual({
        status: OrderMessageOutcomeStatus.NOT_SENT,
        reason: OrderMessageNotSentReasons.TOO_LONG
      })
    })

    it('does not use an approved template whose variable is longer than a provider takes', async () => {
      await template(OrderMessageKind.ORDER_SHIPPED, 'Va {{orderNumber}}', {
        channelTemplate: link(WINDOWED, ['customerName'])
      })
      const scenario = await scene({ channel: WINDOWED, wroteHoursAgo: 48, email: 'v@example.com' })
      await owner.customer.update({
        where: { id: scenario.customerId },
        data: { name: 'x'.repeat(1100) }
      })

      expect(await send(scenario)).toMatchObject({
        status: OrderMessageOutcomeStatus.SENT,
        route: OrderMessageRoutes.EMAIL
      })
      expect(await messagesOf(scenario.conversationId)).toHaveLength(0)
    })

    it('uses another conversation of the customer whose window is open when the one of the order is closed', async () => {
      await template(OrderMessageKind.ORDER_SHIPPED, 'Va {{orderNumber}}')
      const scenario = await scene({ channel: WINDOWED, wroteHoursAgo: 48, email: 'o@example.com' })
      const identity = await createCustomerIdentity(owner, {
        storeId: ctx.storeA.id,
        customerId: scenario.customerId,
        channelType: NO_WINDOW
      })
      const other = await createConversation(owner, {
        storeId: ctx.storeA.id,
        customerId: scenario.customerId,
        customerIdentityId: identity.id,
        channelType: NO_WINDOW
      })

      expect(await send(scenario)).toMatchObject({
        status: OrderMessageOutcomeStatus.SENT,
        route: OrderMessageRoutes.CHANNEL_TEXT
      })
      expect(await messagesOf(other.id)).toHaveLength(1)
      expect(await messagesOf(scenario.conversationId)).toHaveLength(0)
      expect(emailsOf(app).jobs).toHaveLength(0)
    })
  })

  describe('idempotency', () => {
    it('sends nothing twice for the same key, whatever the route', async () => {
      await template(OrderMessageKind.ORDER_SHIPPED, 'Va {{orderNumber}}')
      const scenario = await scene({ channel: NO_WINDOW })
      const key = automaticDispatchKey('ship-1', 'PICKED_UP', OrderMessageKind.ORDER_SHIPPED)

      expect(await send(scenario, OrderMessageKind.ORDER_SHIPPED, key)).toMatchObject({
        status: OrderMessageOutcomeStatus.SENT
      })
      expect(await send(scenario, OrderMessageKind.ORDER_SHIPPED, key)).toMatchObject({
        status: OrderMessageOutcomeStatus.DUPLICATE
      })

      expect(await messagesOf(scenario.conversationId)).toHaveLength(1)
      expect(await dispatchesOf(scenario.orderId)).toHaveLength(1)
    })

    it('answers a repeated key with what the first one did, so a retry after a lost response learns it', async () => {
      await template(OrderMessageKind.ORDER_SHIPPED, 'Va {{orderNumber}}')
      const scenario = await scene({ channel: NO_WINDOW })
      const key = automaticDispatchKey('ship-5', 'PICKED_UP', OrderMessageKind.ORDER_SHIPPED)
      const first = await send(scenario, OrderMessageKind.ORDER_SHIPPED, key)

      expect(await send(scenario, OrderMessageKind.ORDER_SHIPPED, key)).toEqual({
        status: OrderMessageOutcomeStatus.DUPLICATE,
        route: OrderMessageRoutes.CHANNEL_TEXT,
        reason: null,
        messageId: first.status === OrderMessageOutcomeStatus.SENT ? first.messageId : 'never'
      })
      const nothing = await scene({ channel: null })
      const stopKey = automaticDispatchKey('ship-6', 'DELIVERED', OrderMessageKind.ORDER_SUMMARY)
      await send(nothing, OrderMessageKind.ORDER_SUMMARY, stopKey)
      expect(await send(nothing, OrderMessageKind.ORDER_SUMMARY, stopKey)).toEqual({
        status: OrderMessageOutcomeStatus.DUPLICATE,
        route: OrderMessageRoutes.NOT_SENT,
        reason: OrderMessageNotSentReasons.NO_TEMPLATE,
        messageId: null
      })
    })

    it('sends once when the same key arrives at the same moment', async () => {
      await template(OrderMessageKind.ORDER_SHIPPED, 'Va {{orderNumber}}')
      const scenario = await scene({ channel: NO_WINDOW })
      const key = automaticDispatchKey('ship-2', 'PICKED_UP', OrderMessageKind.ORDER_SHIPPED)

      const outcomes = await Promise.all([
        send(scenario, OrderMessageKind.ORDER_SHIPPED, key),
        send(scenario, OrderMessageKind.ORDER_SHIPPED, key),
        send(scenario, OrderMessageKind.ORDER_SHIPPED, key)
      ])

      expect(
        outcomes.filter(outcome => outcome.status === OrderMessageOutcomeStatus.SENT)
      ).toHaveLength(1)
      expect(await messagesOf(scenario.conversationId)).toHaveLength(1)
      expect(await dispatchesOf(scenario.orderId)).toHaveLength(1)
    })

    it('sends one email, not two, for the same key', async () => {
      await template(OrderMessageKind.ORDER_DELIVERED, 'Entregado {{orderNumber}}')
      const scenario = await scene({ channel: null, email: 'once@example.com' })
      const key = automaticDispatchKey('ship-3', 'DELIVERED', OrderMessageKind.ORDER_DELIVERED)

      await Promise.all([
        send(scenario, OrderMessageKind.ORDER_DELIVERED, key),
        send(scenario, OrderMessageKind.ORDER_DELIVERED, key)
      ])

      expect(emailsOf(app).to('once@example.com')).toHaveLength(1)
    })

    it('records a message that was not sent once, so a repeated event does not alert twice', async () => {
      const scenario = await scene({ channel: NO_WINDOW })
      const key = automaticDispatchKey('ship-4', 'DELIVERED', OrderMessageKind.RETURN_APPROVED)

      await send(scenario, OrderMessageKind.RETURN_APPROVED, key)
      expect(await send(scenario, OrderMessageKind.RETURN_APPROVED, key)).toMatchObject({
        status: OrderMessageOutcomeStatus.DUPLICATE
      })
      expect(await dispatchesOf(scenario.orderId)).toHaveLength(1)
    })
  })

  describe('POST /orders/:id/messages', () => {
    const post = (actor: typeof sender, orderId: string, body: object, query = '') =>
      api(app, actor, ctx.storeA)
        .post(`${ApiRoutes.orders.messages(orderId)}${query}`)
        .send(body)

    // The packages a message of the way back or of a replacement refers to (Step 4.12, R1b-2): the guide of the return leg, and the
    // outbound one of the replacement order
    async function guided(orderId: string, guideNumber: string, kind: 'return' | 'outbound') {
      const connection = await createCarrierConnection(owner, {
        storeId: ctx.storeA.id,
        prefix: `M${randomUUID()
          .slice(0, 3)
          .toUpperCase()
          .replace(/[^A-Z0-9]/g, '0')}`
      })
      const orderReturn =
        kind === 'return'
          ? await owner.orderReturn.create({
              data: {
                storeId: ctx.storeA.id,
                orderId,
                type: 'refund',
                reason: 'DEFECTIVE',
                status: 'approved',
                shippingPayer: 'sender',
                createdBy: sender.id
              },
              select: { id: true }
            })
          : null
      return owner.shipment.create({
        data: {
          storeId: ctx.storeA.id,
          orderId,
          connectionId: connection.id,
          kind,
          ...(orderReturn === null ? {} : { returnId: orderReturn.id }),
          serviceCode: connection.serviceCode,
          shippingPayer: 'sender',
          currency: 'USD',
          status: 'label_created',
          guideNumber,
          idempotencyKey: `m-${randomUUID()}`,
          createdBy: 'system'
        },
        select: { id: true }
      })
    }

    it('tells the way back with the guide of the return, by the id it names or by the live one, and never reads the guide of another order', async () => {
      await template(
        OrderMessageKind.RETURN_APPROVED,
        'Devolución {{orderNumber}} guía {{trackingNumber}}'
      )
      const scenario = await scene({ channel: NO_WINDOW })
      const guide = await guided(scenario.orderId, 'RET-0001', 'return')
      const other = await scene({ channel: NO_WINDOW })
      const foreign = await guided(other.orderId, 'RET-9999', 'return')
      const press = (shipmentId?: string, orderId = scenario.orderId) =>
        post(sender, orderId, {
          kind: OrderMessageKind.RETURN_APPROVED,
          idempotencyKey: randomUUID(),
          ...(shipmentId === undefined ? {} : { shipmentId })
        })

      expect((await press(guide.id)).body as MessageOutcomeBody).toMatchObject({
        status: OrderMessageOutcomeStatus.SENT
      })
      expect((await press()).body as MessageOutcomeBody).toMatchObject({
        status: OrderMessageOutcomeStatus.SENT
      })
      const texts = (await messagesOf(scenario.conversationId)).map(message => message.content)
      expect(texts).toHaveLength(2)
      for (const text of texts) expect(text).toContain('RET-0001')

      // A guide of another order is not found for this one: the message has no number and is not sent
      const refused = await press(foreign.id)
      expect(refused.body as MessageOutcomeBody).toMatchObject({
        status: OrderMessageOutcomeStatus.NOT_SENT,
        reason: OrderMessageNotSentReasons.MISSING_VARIABLE
      })
      expect(JSON.stringify(await messagesOf(scenario.conversationId))).not.toContain('RET-9999')
    })

    it('does not tell the way back with an outbound guide, nor a shipped order with a guide of the way back, nor guess between two returns', async () => {
      await template(OrderMessageKind.RETURN_APPROVED, 'Devolución guía {{trackingNumber}}')
      await template(OrderMessageKind.ORDER_SHIPPED, 'Va guía {{trackingNumber}}')
      const scenario = await scene({ channel: NO_WINDOW })
      const outbound = await guided(scenario.orderId, 'OUT-7777', 'outbound')
      const first = await guided(scenario.orderId, 'RET-1111', 'return')
      const press = (kind: OrderMessageKindType, shipmentId?: string) =>
        post(sender, scenario.orderId, {
          kind,
          idempotencyKey: randomUUID(),
          ...(shipmentId === undefined ? {} : { shipmentId })
        })
      const notSent = {
        status: OrderMessageOutcomeStatus.NOT_SENT,
        reason: OrderMessageNotSentReasons.MISSING_VARIABLE
      }

      // The wrong kind of guide is not found for the kind of the message
      expect((await press(OrderMessageKind.RETURN_APPROVED, outbound.id)).body).toMatchObject(
        notSent
      )
      expect((await press(OrderMessageKind.ORDER_SHIPPED, first.id)).body).toMatchObject(notSent)
      // One live guide of the way back is the one; a second return makes it ambiguous and the message is not sent until one is named
      expect((await press(OrderMessageKind.RETURN_APPROVED)).body).toMatchObject({
        status: OrderMessageOutcomeStatus.SENT
      })
      const second = await guided(scenario.orderId, 'RET-2222', 'return')
      expect((await press(OrderMessageKind.RETURN_APPROVED)).body).toMatchObject(notSent)
      expect((await press(OrderMessageKind.RETURN_APPROVED, second.id)).body).toMatchObject({
        status: OrderMessageOutcomeStatus.SENT
      })
      const texts = (await messagesOf(scenario.conversationId)).map(message => message.content)
      expect(texts.join('|')).toContain('RET-1111')
      expect(texts.join('|')).toContain('RET-2222')
      expect(texts.join('|')).not.toContain('OUT-7777')
    })

    it('tells a replacement with the outbound guide of the replacement order', async () => {
      await template(
        OrderMessageKind.EXCHANGE_SHIPPED,
        'Cambio {{orderNumber}} guía {{trackingNumber}}'
      )
      const scenario = await scene({ channel: NO_WINDOW })
      await guided(scenario.orderId, 'OUT-0001', 'outbound')

      const response = await post(sender, scenario.orderId, {
        kind: OrderMessageKind.EXCHANGE_SHIPPED,
        idempotencyKey: randomUUID()
      })

      expect(response.body as MessageOutcomeBody).toMatchObject({
        status: OrderMessageOutcomeStatus.SENT
      })
      expect((await messagesOf(scenario.conversationId))[0]?.content).toContain('OUT-0001')
    })

    it('sends by hand with the key of the press, and the same key sends once', async () => {
      await template(OrderMessageKind.ORDER_SUMMARY, 'Resumen {{orderNumber}}')
      const scenario = await scene({ channel: NO_WINDOW })
      const body = { kind: OrderMessageKind.ORDER_SUMMARY, idempotencyKey: randomUUID() }

      const first = await post(sender, scenario.orderId, body)
      const again = await post(sender, scenario.orderId, body)
      const pressedAgain = await post(sender, scenario.orderId, {
        ...body,
        idempotencyKey: randomUUID()
      })

      expect(first.status).toBe(OK)
      expect(first.body as MessageOutcomeBody).toMatchObject({
        status: OrderMessageOutcomeStatus.SENT,
        route: OrderMessageRoutes.CHANNEL_TEXT
      })
      expect((again.body as MessageOutcomeBody).status).toBe(OrderMessageOutcomeStatus.DUPLICATE)
      expect((pressedAgain.body as MessageOutcomeBody).status).toBe(OrderMessageOutcomeStatus.SENT)
      expect(await messagesOf(scenario.conversationId)).toHaveLength(2)
      const rows = await dispatchesOf(scenario.orderId)
      expect(rows.every(row => row.trigger === OrderMessageTriggers.MANUAL)).toBe(true)
      expect(rows.every(row => row.requestedBy === sender.id)).toBe(true)
    })

    it('answers the reason, not an error, when the message cannot go', async () => {
      const scenario = await scene({ channel: null })

      const response = await post(sender, scenario.orderId, {
        kind: OrderMessageKind.ORDER_SUMMARY,
        idempotencyKey: randomUUID()
      })

      expect(response.status).toBe(OK)
      expect(response.body as MessageOutcomeBody).toEqual({
        status: OrderMessageOutcomeStatus.NOT_SENT,
        reason: OrderMessageNotSentReasons.NO_TEMPLATE
      })
    })

    it('previews the message from the real order and sends nothing', async () => {
      await template(OrderMessageKind.ORDER_SHIPPED, 'Hola {{customerName}}, {{orderNumber}}')
      const scenario = await scene({ channel: NO_WINDOW })

      const response = await post(
        sender,
        scenario.orderId,
        { kind: OrderMessageKind.ORDER_SHIPPED, idempotencyKey: randomUUID() },
        '?preview=true'
      )

      expect(response.status).toBe(OK)
      expect(response.body).toMatchObject({ preview: true, ok: true, locale: 'es' })
      expect((response.body as { text: string }).text).toMatch(/^Hola Ana, T-/)
      expect(await messagesOf(scenario.conversationId)).toHaveLength(0)
      expect(await dispatchesOf(scenario.orderId)).toHaveLength(0)
    })

    it('does not preview a message that send would refuse for who the customer is', async () => {
      await template(OrderMessageKind.ORDER_SHIPPED, 'Va {{orderNumber}}')
      const scenario = await scene({ channel: NO_WINDOW })
      await owner.customer.update({
        where: { id: scenario.customerId },
        data: { erasedAt: new Date() }
      })

      const response = await post(
        sender,
        scenario.orderId,
        { kind: OrderMessageKind.ORDER_SHIPPED },
        '?preview=true'
      )

      expect(response.body).toEqual({
        preview: true,
        ok: false,
        reason: OrderMessageNotSentReasons.CUSTOMER_ERASED,
        missing: []
      })
    })

    it('previews the missing variables instead of a text with a hole', async () => {
      await template(OrderMessageKind.ORDER_OUT_FOR_DELIVERY, 'El {{scheduledDeliveryDate}}')
      const scenario = await scene({ channel: NO_WINDOW })

      const response = await post(
        sender,
        scenario.orderId,
        { kind: OrderMessageKind.ORDER_OUT_FOR_DELIVERY, idempotencyKey: randomUUID() },
        '?preview=true'
      )

      expect(response.body).toEqual({
        preview: true,
        ok: false,
        reason: OrderMessageNotSentReasons.MISSING_VARIABLE,
        missing: ['scheduledDeliveryDate']
      })
    })

    it('previews with no key, and refuses to send without one', async () => {
      await template(OrderMessageKind.ORDER_SHIPPED, 'Va {{orderNumber}}')
      const scenario = await scene({ channel: NO_WINDOW })

      const preview = await post(
        sender,
        scenario.orderId,
        { kind: OrderMessageKind.ORDER_SHIPPED },
        '?preview=true'
      )
      const send = await post(sender, scenario.orderId, { kind: OrderMessageKind.ORDER_SHIPPED })

      expect(preview.status).toBe(OK)
      expect(preview.body).toMatchObject({ preview: true, ok: true })
      expect(send.status).toBe(BAD_REQUEST)
      expect(await messagesOf(scenario.conversationId)).toHaveLength(0)
    })

    it('does not alert the member who pressed the button, and alerts the others who may send', async () => {
      const scenario = await scene({ channel: null })

      await post(sender, scenario.orderId, {
        kind: OrderMessageKind.ORDER_SUMMARY,
        idempotencyKey: randomUUID()
      })

      const told = (
        await eventually(
          () => noticesOf(scenario.orderId),
          rows => rows.length > 0
        )
      ).map(row => row.userId)
      expect(told).toContain(ctx.adminA.id)
      expect(told).not.toContain(sender.id)
    })

    it('is for who may send order messages: a viewer is refused', async () => {
      const scenario = await scene({ channel: NO_WINDOW })

      const response = await post(viewer, scenario.orderId, {
        kind: OrderMessageKind.ORDER_SUMMARY,
        idempotencyKey: randomUUID()
      })

      expect(response.status).toBe(FORBIDDEN)
    })

    it('refuses a kind that does not exist and a key that is not one', async () => {
      const scenario = await scene({ channel: NO_WINDOW })

      expect(
        (
          await post(sender, scenario.orderId, {
            kind: 'order_nothing',
            idempotencyKey: randomUUID()
          })
        ).status
      ).toBe(BAD_REQUEST)
      expect(
        (
          await post(sender, scenario.orderId, {
            kind: OrderMessageKind.ORDER_SUMMARY,
            idempotencyKey: 'a b'
          })
        ).status
      ).toBe(BAD_REQUEST)
      expect(
        (
          await post(sender, scenario.orderId, {
            kind: OrderMessageKind.ORDER_SUMMARY,
            idempotencyKey: randomUUID(),
            extra: 1
          })
        ).status
      ).toBe(BAD_REQUEST)
    })

    it('does not reach an order of another store, with or without preview', async () => {
      const foreign = await createOrder(owner, { storeId: ctx.storeB.id, status: 'CONFIRMED' })
      const body = { kind: OrderMessageKind.ORDER_SUMMARY, idempotencyKey: randomUUID() }

      expect((await post(sender, foreign.id, body)).status).toBe(NOT_FOUND)
      expect((await post(sender, foreign.id, body, '?preview=true')).status).toBe(NOT_FOUND)
      expect(await dispatchesOf(foreign.id)).toHaveLength(0)
      // And nothing went out: no message to a channel, no email
      expect(outbound.jobs).toHaveLength(0)
      expect(emailsOf(app).jobs).toHaveLength(0)
    })
  })

  describe('the history of an order', () => {
    const history = (actor: typeof sender, orderId: string, query = '', store = ctx.storeA) =>
      api(app, actor, store).get(`${ApiRoutes.orders.messages(orderId)}${query}`)
    const dispatch = (orderId: string, over: object = {}) =>
      owner.orderMessageDispatch.create({
        data: {
          storeId: ctx.storeA.id,
          orderId,
          kind: OrderMessageKind.ORDER_SHIPPED,
          trigger: OrderMessageTriggers.MANUAL,
          route: OrderMessageRoutes.EMAIL,
          idempotencyKey: `hist-${randomUUID()}`,
          ...over
        }
      })

    it('lists the messages newest first, with who asked, the reason of one that did not go and a page cursor', async () => {
      const order = await createOrder(owner, { storeId: ctx.storeA.id })
      const at = (minutes: number) => new Date(Date.now() - (3 - minutes) * 60_000)
      const first = await dispatch(order.id, { requestedBy: sender.id, createdAt: at(1) })
      await dispatch(order.id, {
        route: OrderMessageRoutes.NOT_SENT,
        reason: OrderMessageNotSentReasons.MISSING_VARIABLE,
        createdAt: at(2)
      })
      const third = await dispatch(order.id, { requestedBy: randomUUID(), createdAt: at(3) })

      const page = await history(viewer, order.id, '?limit=2')
      expect(page.status).toBe(OK)
      const body = page.body as {
        data: Array<Record<string, unknown>>
        nextCursor: string | null
        hasMore: boolean
      }
      expect(body.hasMore).toBe(true)
      expect(body.data).toHaveLength(2)
      expect(body.data[0]).toMatchObject({ id: third.id, status: 'sent', requestedBy: null })
      expect(body.data[1]).toMatchObject({
        status: OrderMessageOutcomeStatus.NOT_SENT,
        reason: OrderMessageNotSentReasons.MISSING_VARIABLE
      })
      expect(JSON.stringify(body)).not.toContain('idempotencyKey')

      const next = await history(viewer, order.id, `?limit=2&cursor=${body.nextCursor ?? ''}`)
      const rest = next.body as { data: Array<Record<string, unknown>>; hasMore: boolean }
      expect(rest.hasMore).toBe(false)
      expect(rest.data).toHaveLength(1)
      expect(rest.data[0]).toMatchObject({ id: first.id, requestedBy: { id: sender.id } })
    })

    it('breaks a tie of the moment by id, so a page never repeats or skips a row', async () => {
      const order = await createOrder(owner, { storeId: ctx.storeA.id })
      const same = new Date(Date.now() - 60_000)
      const rows = [
        await dispatch(order.id, { createdAt: same }),
        await dispatch(order.id, { createdAt: same }),
        await dispatch(order.id, { createdAt: same })
      ]
      const seen: string[] = []
      let cursor = ''
      for (let page = 0; page < 3; page += 1) {
        const body = (await history(viewer, order.id, `?limit=1${cursor}`)).body as {
          data: Array<{ id: string }>
          nextCursor: string | null
        }
        seen.push(...body.data.map(row => row.id))
        cursor = `&cursor=${body.nextCursor ?? ''}`
      }
      expect(seen).toEqual(
        rows
          .map(row => row.id)
          .sort()
          .reverse()
      )
    })

    it('names only a member who is still in the store, and reads no delivery of another store', async () => {
      const order = await createOrder(owner, { storeId: ctx.storeA.id })
      const foreignMessage = await createMessageOf(owner, { storeId: ctx.storeB.id })
      await owner.message.update({
        where: { id: foreignMessage.id },
        data: { deliveryStatus: DeliveryStatus.FAILED, deliveryError: 'of_store_b' }
      })
      const outsider = await actorWithPermissions(owner, app, {
        prefix,
        name: 'orderMessageOutsider',
        organizationId: ctx.orgB.id,
        storeId: ctx.storeB.id,
        permissions: [Permissions.ORDERS_VIEW]
      })
      await dispatch(order.id, {
        route: OrderMessageRoutes.CHANNEL_TEXT,
        messageId: foreignMessage.id,
        requestedBy: outsider.id
      })

      const body = (await history(viewer, order.id)).body as {
        data: Array<Record<string, unknown>>
      }
      expect(body.data[0]).toMatchObject({
        status: OrderMessageOutcomeStatus.SENT,
        deliveryStatus: null,
        deliveryError: null,
        requestedBy: null
      })
    })

    it('says whether the channel took a message that went through one', async () => {
      const order = await createOrder(owner, { storeId: ctx.storeA.id })
      const made = await createMessageOf(owner, { storeId: ctx.storeA.id })
      const message = await owner.message.update({
        where: { id: made.id },
        data: {
          content: 'texto privado',
          deliveryStatus: DeliveryStatus.FAILED,
          deliveryError: 'channel_rejected'
        }
      })
      await dispatch(order.id, { route: OrderMessageRoutes.CHANNEL_TEXT, messageId: message.id })

      const body = (await history(viewer, order.id)).body as {
        data: Array<Record<string, unknown>>
      }
      expect(body.data[0]).toMatchObject({
        route: OrderMessageRoutes.CHANNEL_TEXT,
        deliveryStatus: DeliveryStatus.FAILED,
        deliveryError: 'channel_rejected'
      })
      expect(JSON.stringify(body)).not.toContain('texto privado')
    })

    it('needs the permission to see orders, and refuses a bad cursor or limit', async () => {
      const order = await createOrder(owner, { storeId: ctx.storeA.id })
      const blind = await actorWithPermissions(owner, app, {
        prefix,
        name: 'orderMessageBlind',
        organizationId: ctx.orgA.id,
        storeId: ctx.storeA.id,
        permissions: [Permissions.CONVERSATIONS_VIEW]
      })

      expect((await history(blind, order.id)).status).toBe(FORBIDDEN)
      expect((await history(viewer, order.id, '?cursor=nope')).status).toBe(BAD_REQUEST)
      expect((await history(viewer, order.id, '?limit=101')).status).toBe(BAD_REQUEST)
    })

    it('does not reach the history of an order of another store, and never lists a row of another store', async () => {
      const foreign = await createOrder(owner, { storeId: ctx.storeB.id })
      await owner.orderMessageDispatch.create({
        data: {
          storeId: ctx.storeB.id,
          orderId: foreign.id,
          kind: OrderMessageKind.ORDER_SHIPPED,
          trigger: OrderMessageTriggers.MANUAL,
          route: OrderMessageRoutes.EMAIL,
          idempotencyKey: `hist-${randomUUID()}`
        }
      })

      expect((await history(viewer, foreign.id)).status).toBe(NOT_FOUND)
    })
  })

  describe('the isolation of the templates and the dispatches', () => {
    it('is refused by the database when a record pairs an order with another store', async () => {
      const foreign = await createOrder(owner, { storeId: ctx.storeB.id })

      await expect(
        owner.orderMessageDispatch.create({
          data: {
            storeId: ctx.storeA.id,
            orderId: foreign.id,
            kind: OrderMessageKind.ORDER_SHIPPED,
            trigger: OrderMessageTriggers.AUTOMATIC,
            route: OrderMessageRoutes.EMAIL,
            idempotencyKey: `cross-${randomUUID()}`
          }
        })
      ).rejects.toThrow(/foreign key/i)
    })

    it('refuses a kind and a reason that are not in the sets, and a reason on a message that went', async () => {
      const order = await createOrder(owner, { storeId: ctx.storeA.id })
      const row = (over: object) =>
        owner.orderMessageDispatch.create({
          data: {
            storeId: ctx.storeA.id,
            orderId: order.id,
            kind: OrderMessageKind.ORDER_SHIPPED,
            trigger: OrderMessageTriggers.AUTOMATIC,
            route: OrderMessageRoutes.NOT_SENT,
            reason: OrderMessageNotSentReasons.NO_TEMPLATE,
            idempotencyKey: `shape-${randomUUID()}`,
            ...over
          }
        })

      await expect(row({ kind: 'nothing' })).rejects.toThrow(/chk_order_message_dispatches_kind/)
      await expect(row({ reason: 'nothing' })).rejects.toThrow(
        /chk_order_message_dispatches_reason/
      )
      await expect(row({ route: OrderMessageRoutes.EMAIL })).rejects.toThrow(
        /chk_order_message_dispatches_reason/
      )
      await expect(row({ reason: null })).rejects.toThrow(/chk_order_message_dispatches_reason/)
    })

    it('reads only the template of its own store, even when another store has the same kind and language', async () => {
      await template(OrderMessageKind.ORDER_SHIPPED, 'De la tienda B {{orderNumber}}', {
        storeId: ctx.storeB.id
      })
      const scenario = await scene({ channel: NO_WINDOW })

      expect(await send(scenario)).toEqual({
        status: OrderMessageOutcomeStatus.NOT_SENT,
        reason: OrderMessageNotSentReasons.NO_TEMPLATE
      })
    })

    it('keeps an idempotency key apart per store', async () => {
      const key = 'auto:shared-key'
      await owner.orderMessageDispatch.create({
        data: {
          storeId: ctx.storeB.id,
          orderId: (await createOrder(owner, { storeId: ctx.storeB.id })).id,
          kind: OrderMessageKind.ORDER_SHIPPED,
          trigger: OrderMessageTriggers.AUTOMATIC,
          route: OrderMessageRoutes.EMAIL,
          idempotencyKey: key
        }
      })
      await template(OrderMessageKind.ORDER_SHIPPED, 'Va {{orderNumber}}')
      const scenario = await scene({ channel: NO_WINDOW })

      expect(await send(scenario, OrderMessageKind.ORDER_SHIPPED, key)).toMatchObject({
        status: OrderMessageOutcomeStatus.SENT
      })
    })
  })
})
