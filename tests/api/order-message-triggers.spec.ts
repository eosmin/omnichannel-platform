import { randomUUID } from 'node:crypto'

import { getQueueToken } from '@nestjs/bullmq'
import type { INestApplication } from '@nestjs/common'
import { EventEmitter2 } from '@nestjs/event-emitter'

import { ApiRoutes } from '@platform/core/api'
import type { OwnerClient } from '@platform/core/database-testing'
import {
  AuthorType,
  ConversationStatus,
  DeliveryStatus,
  FailedAttemptMessagePolicy,
  MediaStatus,
  MessageType,
  OrderMessageKind,
  type OrderMessageKindType,
  OrderMessageNotSentReasons,
  OrderMessageRoutes,
  OrderMessageTriggers,
  OrderStatus,
  ShipmentStatus
} from '@platform/core/domain'
import { Events } from '@platform/core/events'
import { Locales } from '@platform/core/i18n'
import { NotificationTypes } from '@platform/core/notifications'
import { QueueNames } from '@platform/core/queues'
import { MediaPurpose } from '@platform/core/storage'
import { StorageService } from '@platform/core/storage-module'
import { PluginRegistry } from '@platform/plugins/runtime'
import { ChannelCapability } from '@platform/plugins/sdk'

import {
  buildChannelPlugin,
  createConversation,
  createCustomerIdentity,
  createShipment
} from '../builders'
import { createTestApp } from '../helpers/app'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { emailsOf } from '../helpers/email'
import { ordersKit, type OrdersKit } from '../helpers/orders'
import { CapturedQueue } from '../helpers/queue'

const CREATED = 201
const OK = 200
const WAIT_ATTEMPTS = 40
const WAIT_MS = 50

// The declarations the suite's channels make, never the name of a plugin (rule 13): no window, with documents; no window, with no
// documents; and no window, with documents of a type that is not a PDF
const WITH_DOCUMENTS = 'omt_with_documents'
const TEXT_ONLY = 'omt_text_only'
const NO_PDF = 'omt_no_pdf'

// The messages the orders send by themselves (TDD_17 §4.7, §4.9, Step 4.9 PR C2b): the summary when an order is created, the message
// of a status that a person set with its box, and the message of each status of a shipment.
describe('Order messages that go by themselves', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  let kit: OrdersKit
  let storage: StorageService
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
    kit = ordersKit(owner, app, ctx)
    storage = app.get(StorageService, { strict: false })
    const registry = app.get(PluginRegistry, { strict: false })
    const sent = () =>
      Promise.resolve({
        externalId: 'ext',
        status: DeliveryStatus.SENT,
        sentAt: new Date().toISOString()
      })
    registry.register(
      buildChannelPlugin({
        id: WITH_DOCUMENTS,
        capabilities: [ChannelCapability.TEXT, ChannelCapability.DOCUMENT],
        messagingWindow: null,
        sendMedia: sent
      })
    )
    registry.register(
      buildChannelPlugin({
        id: TEXT_ONLY,
        capabilities: [ChannelCapability.TEXT],
        messagingWindow: null
      })
    )
    registry.register(
      buildChannelPlugin({
        id: NO_PDF,
        capabilities: [ChannelCapability.TEXT, ChannelCapability.DOCUMENT],
        messagingWindow: null,
        media: {
          maxFilesPerMessage: 1,
          kinds: { document: { types: ['text/plain'], maxBytes: 1024 * 1024 } }
        },
        sendMedia: sent
      })
    )
  })
  afterAll(async () => {
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })
  beforeEach(async () => {
    await owner.orderMessageTemplate.deleteMany({ where: { storeId: ctx.storeA.id } })
    await kit.resetSettings()
    outbound.jobs.length = 0
    pushQueue.jobs.length = 0
    emailsOf(app).clear()
  })

  const emit = (event: string, payload: object) => app.get(EventEmitter2).emitAsync(event, payload)
  const template = (
    kind: OrderMessageKindType,
    body: string,
    extra: { autoSend?: boolean; attachSummary?: boolean } = {}
  ) =>
    owner.orderMessageTemplate.create({
      data: {
        storeId: ctx.storeA.id,
        kind,
        locale: Locales.ES,
        body,
        autoSend: extra.autoSend ?? false,
        attachSummary: extra.attachSummary ?? false
      }
    })
  const preferences = (value: object) =>
    owner.storeSettings.update({
      where: { storeId: ctx.storeA.id },
      data: { preferences: value }
    })

  // A conversation of the customer of an order, over a channel, and the order pointing at it
  async function conversationOf(
    orderId: string,
    channel: string,
    status?: ConversationStatus
  ): Promise<string> {
    const order = await owner.order.findFirstOrThrow({
      where: { id: orderId },
      select: { customerId: true }
    })
    const identity = await createCustomerIdentity(owner, {
      storeId: ctx.storeA.id,
      customerId: order.customerId,
      channelType: channel
    })
    const conversation = await createConversation(owner, {
      storeId: ctx.storeA.id,
      customerId: order.customerId,
      customerIdentityId: identity.id,
      channelType: channel,
      ...(status === undefined ? {} : { status })
    })
    await owner.order.update({ where: { id: orderId }, data: { conversationId: conversation.id } })
    return conversation.id
  }
  // What the thread says to the customer: the line that an order writes into the thread of the conversation it came from (the type
  // ORDER_SUMMARY, which is never sent) is not a message
  const messagesOf = (conversationId: string) =>
    owner.message.findMany({
      where: { conversationId, type: { not: MessageType.ORDER_SUMMARY } },
      orderBy: { createdAt: 'asc' }
    })
  const dispatchesOf = (orderId: string) =>
    owner.orderMessageDispatch.findMany({ where: { orderId }, orderBy: { createdAt: 'asc' } })

  async function eventually<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
    let value = await read()
    for (let attempt = 0; attempt < WAIT_ATTEMPTS && !done(value); attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, WAIT_MS))
      value = await read()
    }
    return value
  }
  const noticesOf = (type: string, orderId: string) =>
    owner.notification.findMany({ where: { storeId: ctx.storeA.id, type, resourceId: orderId } })

  // An order made through the api, as a person does: its customer with a conversation over a channel when one is asked
  async function created(extra: Record<string, unknown>, channel: string | null = TEXT_ONLY) {
    const body = await kit.orderBody(extra)
    // The conversation is made first, so that the order is created with it: the thread it came from
    let conversationId: string | undefined
    if (channel !== null) {
      const identity = await createCustomerIdentity(owner, {
        storeId: ctx.storeA.id,
        customerId: body.customerId,
        channelType: channel
      })
      conversationId = (
        await createConversation(owner, {
          storeId: ctx.storeA.id,
          customerId: body.customerId,
          customerIdentityId: identity.id,
          channelType: channel
        })
      ).id
    }
    const response = await kit
      .asAdmin()
      .post(ApiRoutes.orders.create)
      .send({ ...body, ...(conversationId === undefined ? {} : { conversationId }) })
    expect(response.status).toBe(CREATED)
    const orderId = (response.body as { order: { id: string } }).order.id
    return { orderId, conversationId: conversationId ?? null }
  }

  describe('the summary when an order is created', () => {
    it('is sent through the conversation when the person asked for it', async () => {
      await template(OrderMessageKind.ORDER_SUMMARY, 'Tu pedido {{orderNumber}} de {{storeName}}')

      const { orderId, conversationId } = await created({ sendConfirmationMessage: true })

      const messages = await eventually(
        () => messagesOf(conversationId ?? ''),
        rows => rows.length > 0
      )
      expect(messages.filter(row => row.type === String(MessageType.TEXT))).toHaveLength(1)
      const text = messages.find(row => row.type === String(MessageType.TEXT))
      expect(text).toMatchObject({
        authorType: AuthorType.SYSTEM,
        deliveryStatus: DeliveryStatus.QUEUED
      })
      expect(text?.content).toMatch(/^Tu pedido .+ de /)
      const [row] = await dispatchesOf(orderId)
      expect(row).toMatchObject({
        kind: OrderMessageKind.ORDER_SUMMARY,
        trigger: OrderMessageTriggers.AUTOMATIC,
        route: OrderMessageRoutes.CHANNEL_TEXT
      })
    })

    it('follows the preference of the store when the person did not say, which is on by default', async () => {
      await template(OrderMessageKind.ORDER_SUMMARY, 'Resumen {{orderNumber}}')

      const { conversationId } = await created({})

      expect(
        (
          await eventually(
            () => messagesOf(conversationId ?? ''),
            rows => rows.length > 0
          )
        ).length
      ).toBe(1)
    })

    it('sends nothing when the preference is off and the person did not say', async () => {
      await template(OrderMessageKind.ORDER_SUMMARY, 'Resumen {{orderNumber}}')
      await preferences({ orders: { sendSummaryOnCreate: false } })

      const { orderId, conversationId } = await created({})
      await new Promise(resolve => setTimeout(resolve, WAIT_ATTEMPTS * WAIT_MS))

      expect(await messagesOf(conversationId ?? '')).toHaveLength(0)
      expect(await dispatchesOf(orderId)).toHaveLength(0)
    })

    it('does what the person said over what the preference says, in both directions', async () => {
      await template(OrderMessageKind.ORDER_SUMMARY, 'Resumen {{orderNumber}}')
      await preferences({ orders: { sendSummaryOnCreate: false } })
      const asked = await created({ sendConfirmationMessage: true })
      expect(
        (
          await eventually(
            () => messagesOf(asked.conversationId ?? ''),
            rows => rows.length > 0
          )
        ).length
      ).toBe(1)

      await preferences({ orders: { sendSummaryOnCreate: true } })
      const refused = await created({ sendConfirmationMessage: false })
      await new Promise(resolve => setTimeout(resolve, WAIT_ATTEMPTS * WAIT_MS))
      expect(await messagesOf(refused.conversationId ?? '')).toHaveLength(0)
    })

    it('says so to the team when the store has no template of the summary', async () => {
      const { orderId, conversationId } = await created({ sendConfirmationMessage: true })

      const notices = await eventually(
        () => noticesOf(NotificationTypes.ORDER_MESSAGE_NOT_SENT, orderId),
        rows => rows.length > 0
      )
      expect(notices.length).toBeGreaterThan(0)
      expect(await messagesOf(conversationId ?? '')).toHaveLength(0)
      expect((await dispatchesOf(orderId))[0]).toMatchObject({
        route: OrderMessageRoutes.NOT_SENT,
        reason: OrderMessageNotSentReasons.NO_TEMPLATE
      })
    })

    it('sends it once when the event is heard twice', async () => {
      await template(OrderMessageKind.ORDER_SUMMARY, 'Resumen {{orderNumber}}')
      const { orderId, conversationId } = await created({ sendConfirmationMessage: true })
      await eventually(
        () => messagesOf(conversationId ?? ''),
        rows => rows.length > 0
      )
      const order = await owner.order.findFirstOrThrow({
        where: { id: orderId },
        select: { orderNumber: true, customerId: true }
      })

      await emit(Events.ORDER_CREATED, {
        storeId: ctx.storeA.id,
        orderId,
        orderNumber: order.orderNumber,
        actor: { type: 'user', id: ctx.adminA.id },
        customerId: order.customerId,
        conversationId,
        totalCents: 1,
        currency: 'USD',
        sendSummary: true
      })

      expect(await messagesOf(conversationId ?? '')).toHaveLength(1)
      expect(await dispatchesOf(orderId)).toHaveLength(1)
    })
  })

  describe('the summary with its document', () => {
    it('sends the PDF as a document right after the text, on a channel that takes documents', async () => {
      await template(OrderMessageKind.ORDER_SUMMARY, 'Resumen {{orderNumber}}', {
        attachSummary: true
      })

      const { conversationId } = await created({ sendConfirmationMessage: true }, WITH_DOCUMENTS)

      const messages = await eventually(
        () => messagesOf(conversationId ?? ''),
        rows => rows.length >= 2
      )
      expect(messages.map(row => row.type)).toEqual([MessageType.TEXT, MessageType.DOCUMENT])
      const document = messages[1]
      expect(document).toMatchObject({
        authorType: AuthorType.SYSTEM,
        content: null,
        deliveryStatus: DeliveryStatus.QUEUED
      })
      const files = await owner.media.findMany({ where: { messageId: document?.id } })
      expect(files).toHaveLength(1)
      expect(files[0]).toMatchObject({
        purpose: MediaPurpose.ORDER,
        contentType: 'application/pdf',
        status: MediaStatus.CLEAN,
        position: 0,
        deliveryStatus: DeliveryStatus.QUEUED
      })
      expect(files[0]?.fileSize).toBeGreaterThan(100)
      // The file is in the bucket, and it is a PDF
      const bytes = await storage.read(files[0]?.key ?? '', 1024 * 1024)
      expect(bytes?.subarray(0, 4).toString('latin1')).toBe('%PDF')
      // Both are queued for the channel
      expect(outbound.jobs.map(job => (job.data as { messageId: string }).messageId)).toEqual(
        expect.arrayContaining(messages.map(row => row.id))
      )
    })

    it('sends only the text when the template does not ask for the document', async () => {
      await template(OrderMessageKind.ORDER_SUMMARY, 'Resumen {{orderNumber}}')

      const { conversationId } = await created({ sendConfirmationMessage: true }, WITH_DOCUMENTS)

      const messages = await eventually(
        () => messagesOf(conversationId ?? ''),
        rows => rows.length > 0
      )
      expect(messages.map(row => row.type)).toEqual([MessageType.TEXT])
    })

    it('sends only the text on a channel that declares no documents', async () => {
      await template(OrderMessageKind.ORDER_SUMMARY, 'Resumen {{orderNumber}}', {
        attachSummary: true
      })

      const { conversationId } = await created({ sendConfirmationMessage: true }, TEXT_ONLY)

      const messages = await eventually(
        () => messagesOf(conversationId ?? ''),
        rows => rows.length > 0
      )
      expect(messages.map(row => row.type)).toEqual([MessageType.TEXT])
      expect(await owner.media.count({ where: { messageId: messages[0]?.id } })).toBe(0)
    })

    it('sends only the text on a channel whose documents are not PDFs', async () => {
      await template(OrderMessageKind.ORDER_SUMMARY, 'Resumen {{orderNumber}}', {
        attachSummary: true
      })

      const { conversationId } = await created({ sendConfirmationMessage: true }, NO_PDF)

      const messages = await eventually(
        () => messagesOf(conversationId ?? ''),
        rows => rows.length > 0
      )
      expect(messages.map(row => row.type)).toEqual([MessageType.TEXT])
    })

    it('attaches nothing to the other kinds, whatever their template says', async () => {
      await template(OrderMessageKind.ORDER_CANCELLED, 'Cancelado {{orderNumber}}', {
        autoSend: true,
        attachSummary: true
      })
      const { orderId, conversationId } = await created({}, WITH_DOCUMENTS)
      await eventually(
        () => dispatchesOf(orderId),
        rows => rows.length > 0
      )
      await owner.orderMessageDispatch.deleteMany({ where: { orderId } })
      await owner.message.deleteMany({ where: { conversationId: conversationId ?? '' } })

      await kit
        .asAdmin()
        .post(ApiRoutes.orders.cancel(orderId))
        .send({ cancellationReason: 'Sin stock' })

      const messages = await eventually(
        () => messagesOf(conversationId ?? ''),
        rows => rows.length > 0
      )
      expect(messages.map(row => row.type)).toEqual([MessageType.TEXT])
    })
  })

  describe('the "Notify customer" box of a status set by hand', () => {
    const cancel = (orderId: string, extra: Record<string, unknown> = {}) =>
      kit
        .asAdmin()
        .post(ApiRoutes.orders.cancel(orderId))
        .send({ cancellationReason: 'Sin stock', ...extra })

    // The creation summary has no template here: its dispatch is not what these cases look at
    async function orderToCancel() {
      await owner.orderMessageTemplate.deleteMany({ where: { storeId: ctx.storeA.id } })
      await preferences({ orders: { sendSummaryOnCreate: false } })
      return created({ sendConfirmationMessage: false })
    }

    it('starts from the autoSend of the template: the customer is told when it is on', async () => {
      const { orderId, conversationId } = await orderToCancel()
      await template(OrderMessageKind.ORDER_CANCELLED, 'Cancelado {{orderNumber}}', {
        autoSend: true
      })

      expect((await cancel(orderId)).status).toBe(OK)

      const messages = await eventually(
        () => messagesOf(conversationId ?? ''),
        rows => rows.length > 0
      )
      expect(messages).toHaveLength(1)
      expect(messages[0]?.content).toMatch(/^Cancelado /)
    })

    it('says nothing when the autoSend of the template is off and the person did not touch the box', async () => {
      const { orderId, conversationId } = await orderToCancel()
      await template(OrderMessageKind.ORDER_CANCELLED, 'Cancelado {{orderNumber}}', {
        autoSend: false
      })

      await cancel(orderId)
      await new Promise(resolve => setTimeout(resolve, WAIT_ATTEMPTS * WAIT_MS))

      expect(await messagesOf(conversationId ?? '')).toHaveLength(0)
      expect(await dispatchesOf(orderId)).toHaveLength(0)
    })

    it('sends when the person checks the box, whatever the template says', async () => {
      const { orderId, conversationId } = await orderToCancel()
      await template(OrderMessageKind.ORDER_CANCELLED, 'Cancelado {{orderNumber}}', {
        autoSend: false
      })

      await cancel(orderId, { notifyCustomer: true })

      expect(
        (
          await eventually(
            () => messagesOf(conversationId ?? ''),
            rows => rows.length > 0
          )
        ).length
      ).toBe(1)
    })

    it('sends nothing when the person unchecks the box, whatever the template says', async () => {
      const { orderId, conversationId } = await orderToCancel()
      await template(OrderMessageKind.ORDER_CANCELLED, 'Cancelado {{orderNumber}}', {
        autoSend: true
      })

      await cancel(orderId, { notifyCustomer: false })
      await new Promise(resolve => setTimeout(resolve, WAIT_ATTEMPTS * WAIT_MS))

      expect(await messagesOf(conversationId ?? '')).toHaveLength(0)
    })

    it('tells the team when the box is checked and the store has no template, and stays quiet when it was not touched', async () => {
      const asked = await orderToCancel()
      await cancel(asked.orderId, { notifyCustomer: true })
      const notices = await eventually(
        () => noticesOf(NotificationTypes.ORDER_MESSAGE_NOT_SENT, asked.orderId),
        rows => rows.length > 0
      )
      // The change went out with its answer and the message goes after it: nobody has been told that it did not go, the person included
      expect(notices.map(row => row.userId)).toContain(ctx.adminA.id)

      const quiet = await orderToCancel()
      await cancel(quiet.orderId)
      await new Promise(resolve => setTimeout(resolve, WAIT_ATTEMPTS * WAIT_MS))
      expect(await dispatchesOf(quiet.orderId)).toHaveLength(0)
      expect(await noticesOf(NotificationTypes.ORDER_MESSAGE_NOT_SENT, quiet.orderId)).toHaveLength(
        0
      )
    })

    it('maps the three statuses a person can set to their kinds, and only a person', async () => {
      const { orderId, conversationId } = await orderToCancel()
      for (const kind of [
        OrderMessageKind.ORDER_SHIPPED,
        OrderMessageKind.ORDER_DELIVERED,
        OrderMessageKind.ORDER_CANCELLED
      ]) {
        await template(kind, `${kind} {{orderNumber}}`, { autoSend: true })
      }
      const change = (to: OrderStatus, actor: { type: 'user' | 'system'; id: string | null }) =>
        emit(Events.ORDER_STATUS_CHANGED, {
          storeId: ctx.storeA.id,
          orderId,
          orderNumber: 'X',
          actor,
          from: OrderStatus.CONFIRMED,
          to,
          notifyCustomer: null
        })
      const person = { type: 'user', id: ctx.adminA.id } as const

      await change(OrderStatus.SHIPPED, person)
      await change(OrderStatus.DELIVERED, person)
      await change(OrderStatus.PREPARING, person)
      await change(OrderStatus.CANCELLED, { type: 'system', id: null })

      const sent = await messagesOf(conversationId ?? '')
      expect(sent.map(row => row.content)).toEqual([
        expect.stringMatching(/^order_shipped /),
        expect.stringMatching(/^order_delivered /)
      ])
    })
  })

  describe('the messages of the shipment', () => {
    // A package of an order with a conversation; the event says what it just became
    async function shipment(
      options: { channel?: string; failedAttempts?: number; status?: ConversationStatus } = {}
    ) {
      const built = await createShipment(owner, { storeId: ctx.storeA.id })
      const conversationId = await conversationOf(
        built.orderId,
        options.channel ?? TEXT_ONLY,
        options.status
      )
      if (options.failedAttempts !== undefined) {
        await owner.shipment.update({
          where: { id: built.id },
          data: { failedAttempts: options.failedAttempts }
        })
      }
      return { ...built, conversationId }
    }
    const moved = (
      built: { id: string; orderId: string; connectionId: string },
      to: ShipmentStatus,
      extra: { replay?: boolean; from?: ShipmentStatus } = {}
    ) =>
      emit(Events.SHIPMENT_STATUS_CHANGED, {
        storeId: ctx.storeA.id,
        shipmentId: built.id,
        orderId: built.orderId,
        orderNumber: 'X',
        connectionId: built.connectionId,
        actor: { type: 'system', id: null },
        from: extra.from ?? ShipmentStatus.LABEL_CREATED,
        to,
        ...(extra.replay === undefined ? {} : { replay: extra.replay })
      })
    const setAttempts = (id: string, failedAttempts: number) =>
      owner.shipment.update({ where: { id }, data: { failedAttempts } })
    const contents = async (conversationId: string) =>
      (await messagesOf(conversationId)).map(row => row.content)

    beforeEach(async () => {
      for (const kind of [
        OrderMessageKind.ORDER_SHIPPED,
        OrderMessageKind.ORDER_OUT_FOR_DELIVERY,
        OrderMessageKind.ORDER_DELIVERED
      ]) {
        await template(kind, `${kind} {{orderNumber}} {{carrierName}}`, { autoSend: true })
      }
      await template(
        OrderMessageKind.ORDER_FAILED_ATTEMPT,
        'intento {{attemptNumber}} de {{maxAttempts}}'
      )
    })

    it('tells that the package left, once, whichever of picked up and in transit comes first', async () => {
      const built = await shipment()

      await moved(built, ShipmentStatus.PICKED_UP)
      await moved(built, ShipmentStatus.IN_TRANSIT, { from: ShipmentStatus.PICKED_UP })

      const sent = await contents(built.conversationId)
      expect(sent).toHaveLength(1)
      expect(sent[0]).toMatch(/^order_shipped T-/)
      const [row] = await dispatchesOf(built.orderId)
      expect(row).toMatchObject({ trigger: OrderMessageTriggers.AUTOMATIC, shipmentId: built.id })
    })

    it('starts from in transit when the carrier never said picked up', async () => {
      const built = await shipment()

      await moved(built, ShipmentStatus.IN_TRANSIT)

      expect(await contents(built.conversationId)).toHaveLength(1)
    })

    it('tells that it is out for delivery and that it was delivered', async () => {
      const built = await shipment()

      await moved(built, ShipmentStatus.OUT_FOR_DELIVERY, { from: ShipmentStatus.IN_TRANSIT })
      await moved(built, ShipmentStatus.DELIVERED, { from: ShipmentStatus.OUT_FOR_DELIVERY })

      expect(await contents(built.conversationId)).toEqual([
        expect.stringMatching(/^order_out_for_delivery /),
        expect.stringMatching(/^order_delivered /)
      ])
    })

    it('sends nothing twice when the carrier repeats an event, and nothing already told when they arrive out of order', async () => {
      const built = await shipment()

      await moved(built, ShipmentStatus.DELIVERED, { from: ShipmentStatus.OUT_FOR_DELIVERY })
      await moved(built, ShipmentStatus.DELIVERED, { from: ShipmentStatus.OUT_FOR_DELIVERY })
      await moved(built, ShipmentStatus.OUT_FOR_DELIVERY, { from: ShipmentStatus.IN_TRANSIT })
      await moved(built, ShipmentStatus.OUT_FOR_DELIVERY, { from: ShipmentStatus.IN_TRANSIT })

      expect(await contents(built.conversationId)).toHaveLength(2)
      expect(await dispatchesOf(built.orderId)).toHaveLength(2)
    })

    it('tells each failed attempt with its number when the preference is every attempt, which is the default', async () => {
      const built = await shipment()

      await setAttempts(built.id, 1)
      await moved(built, ShipmentStatus.FAILED_ATTEMPT)
      await setAttempts(built.id, 2)
      await moved(built, ShipmentStatus.FAILED_ATTEMPT, { from: ShipmentStatus.FAILED_ATTEMPT })
      await moved(built, ShipmentStatus.FAILED_ATTEMPT, { from: ShipmentStatus.FAILED_ATTEMPT })

      expect(await contents(built.conversationId)).toEqual(['intento 1 de 3', 'intento 2 de 3'])
    })

    it('tells only the first failed attempt when the preference says so, and none when it says none', async () => {
      await preferences({
        orders: { failedAttemptMessages: FailedAttemptMessagePolicy.FIRST_ONLY }
      })
      const first = await shipment()
      await setAttempts(first.id, 1)
      await moved(first, ShipmentStatus.FAILED_ATTEMPT)
      await setAttempts(first.id, 2)
      await moved(first, ShipmentStatus.FAILED_ATTEMPT, { from: ShipmentStatus.FAILED_ATTEMPT })
      expect(await contents(first.conversationId)).toEqual(['intento 1 de 3'])

      await preferences({ orders: { failedAttemptMessages: FailedAttemptMessagePolicy.NONE } })
      const none = await shipment()
      await setAttempts(none.id, 1)
      await moved(none, ShipmentStatus.FAILED_ATTEMPT)
      expect(await contents(none.conversationId)).toEqual([])
    })

    it('does not use the autoSend of a template for the failed attempt: the preference is the only switch', async () => {
      await owner.orderMessageTemplate.update({
        where: {
          storeId_kind_locale: {
            storeId: ctx.storeA.id,
            kind: OrderMessageKind.ORDER_FAILED_ATTEMPT,
            locale: Locales.ES
          }
        },
        data: { autoSend: false }
      })
      const built = await shipment()
      await setAttempts(built.id, 1)

      await moved(built, ShipmentStatus.FAILED_ATTEMPT)

      expect(await contents(built.conversationId)).toHaveLength(1)
    })

    it('sends nothing for a kind whose template is not set to go by itself, or that the store never made', async () => {
      await owner.orderMessageTemplate.deleteMany({
        where: { storeId: ctx.storeA.id, kind: OrderMessageKind.ORDER_DELIVERED }
      })
      await owner.orderMessageTemplate.update({
        where: {
          storeId_kind_locale: {
            storeId: ctx.storeA.id,
            kind: OrderMessageKind.ORDER_SHIPPED,
            locale: Locales.ES
          }
        },
        data: { autoSend: false }
      })
      const built = await shipment()

      await moved(built, ShipmentStatus.PICKED_UP)
      await moved(built, ShipmentStatus.DELIVERED, { from: ShipmentStatus.OUT_FOR_DELIVERY })

      expect(await contents(built.conversationId)).toHaveLength(0)
      expect(await dispatchesOf(built.orderId)).toHaveLength(0)
      expect(await noticesOf(NotificationTypes.ORDER_MESSAGE_NOT_SENT, built.orderId)).toHaveLength(
        0
      )
    })

    it('says nothing to the customer for a status the table gives no message', async () => {
      const built = await shipment()

      for (const to of [
        ShipmentStatus.LABEL_CREATED,
        ShipmentStatus.RETURNING,
        ShipmentStatus.RETURNED,
        ShipmentStatus.CANCELLED
      ]) {
        await moved(built, to)
      }

      expect(await contents(built.conversationId)).toHaveLength(0)
    })

    it('never writes to the customer for an event read again after the owner mapped a code, and says nothing twice', async () => {
      const built = await shipment()
      await setAttempts(built.id, 1)

      await moved(built, ShipmentStatus.FAILED_ATTEMPT, { replay: true })
      await moved(built, ShipmentStatus.DELIVERED, { replay: true })

      expect(await contents(built.conversationId)).toHaveLength(0)
      expect(await dispatchesOf(built.orderId)).toHaveLength(0)
    })

    it('tells the team about a replayed failed attempt in the center only, no push', async () => {
      const subscription = await owner.pushSubscription.create({
        data: {
          userId: ctx.adminA.id,
          endpoint: `https://push.example/${randomUUID()}`,
          p256dh: 'p',
          auth: 'a'
        }
      })
      try {
        const live = await shipment()
        await moved(live, ShipmentStatus.FAILED_ATTEMPT)
        await eventually(
          () => noticesOf(NotificationTypes.SHIPMENT_FAILED_ATTEMPT, live.id),
          rows => rows.length > 0
        )
        const pushedLive = pushQueue.jobs.length

        const replayed = await shipment()
        await moved(replayed, ShipmentStatus.FAILED_ATTEMPT, { replay: true })
        const notices = await eventually(
          () => noticesOf(NotificationTypes.SHIPMENT_FAILED_ATTEMPT, replayed.id),
          rows => rows.length > 0
        )

        expect(pushedLive).toBeGreaterThan(0)
        expect(notices.length).toBeGreaterThan(0)
        expect(pushQueue.jobs.length).toBe(pushedLive)
        expect(notices.every(row => row.emailPendingAt === null)).toBe(true)
      } finally {
        await owner.pushSubscription.delete({ where: { id: subscription.id } })
      }
    })

    it('sends nothing for the package of an order that was cancelled', async () => {
      const built = await shipment()
      await owner.order.update({
        where: { id: built.orderId },
        data: { status: OrderStatus.CANCELLED }
      })

      await moved(built, ShipmentStatus.PICKED_UP)

      expect(await contents(built.conversationId)).toHaveLength(0)
    })

    it('does not tell again, with the package, what a person already told by marking the order by hand', async () => {
      const built = await shipment()
      await emit(Events.ORDER_STATUS_CHANGED, {
        storeId: ctx.storeA.id,
        orderId: built.orderId,
        orderNumber: 'X',
        actor: { type: 'user', id: ctx.adminA.id },
        from: OrderStatus.CONFIRMED,
        to: OrderStatus.SHIPPED,
        notifyCustomer: null
      })

      await moved(built, ShipmentStatus.PICKED_UP)
      await moved(built, ShipmentStatus.OUT_FOR_DELIVERY, { from: ShipmentStatus.PICKED_UP })

      expect(await contents(built.conversationId)).toEqual([
        expect.stringMatching(/^order_shipped /),
        expect.stringMatching(/^order_out_for_delivery /)
      ])
    })

    it('goes by email when the conversation is not usable and the customer has an address', async () => {
      const built = await shipment({ status: ConversationStatus.SPAM })
      const order = await owner.order.findFirstOrThrow({
        where: { id: built.orderId },
        select: { customerId: true }
      })
      await owner.customer.update({
        where: { id: order.customerId },
        data: { email: 'pkg@example.com' }
      })

      await moved(built, ShipmentStatus.PICKED_UP)

      expect(emailsOf(app).to('pkg@example.com')).toHaveLength(1)
      expect(await contents(built.conversationId)).toHaveLength(0)
    })
  })
})
