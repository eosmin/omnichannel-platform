import { randomInt, randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'
import supertest from 'supertest'

import { API_PREFIX, ApiRoutes, PluginApiRoutes } from '@platform/core/api'
import { AuditAction } from '@platform/core/audit'
import type { OwnerClient } from '@platform/core/database-testing'
import {
  InventoryMovementType,
  OrderConfirmationChannel,
  OrderMessageKind,
  OrderStatus,
  PaymentMethod,
  PaymentStatus,
  PriceApprovalStatus
} from '@platform/core/domain'
import { ErrorCodes, HttpStatusCodes } from '@platform/core/errors'
import { Locales } from '@platform/core/i18n'
import { PluginScopes } from '@platform/plugins/sdk'

import { createPluginKey } from '../builders'
import { createTestApp } from '../helpers/app'
import { waitForAuditEntries } from '../helpers/audit'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { type ErrorBody, ordersKit, type OrdersKit } from '../helpers/orders'

const OK = 200
const CREATED = 201
const NO_CONTENT = 204
const BAD_REQUEST = 400
const FORBIDDEN = 403
const NOT_FOUND = 404

interface PluginOrderBody {
  id: string
  status: string
  totalCents: number
  priceApprovalStatus: string
  items: { id: string }[]
  // What a plugin must never be given back
  customer?: unknown
  customerId?: unknown
  internalNotes?: unknown
  packingNotes?: unknown
  createdBy?: unknown
  confirmedBy?: unknown
  createdByPluginId?: unknown
}
interface CreatedBody {
  order: PluginOrderBody
  notices: string[]
}

type Key = { key: string; installationId: string }

// TDD_10 §6, Step 5.6 PR E3b: the writes of orders under the key of a plugin, over the same services as the screens. What matters:
// the plugin is recorded as who did it (never as a person), the audit says so, each scope opens only its own route, the key names
// the store, the rules of the order are the ones of a person (stock, status, self-approval), and the answer is the allowlist.
describe('Orders written through the plugin API', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  let kit: OrdersKit
  let writer: Key
  let writerB: Key
  let editor: Key
  let confirmer: Key
  let canceller: Key
  let approver: Key
  let otherApprover: Key
  let messenger: Key
  let templater: Key
  let reader: Key
  let editorB: Key

  const pluginIdOf = (name: string) => `${prefix}-${name}`
  async function keyFor(name: string, scopes: readonly string[], storeId = ctx.storeA.id) {
    return createPluginKey(owner, {
      storeId,
      pluginId: `${prefix}-${name}`,
      scopes: scopes as never
    })
  }

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp()
    ctx = await seedTestContext(owner, app, prefix)
    kit = ordersKit(owner, app, ctx)
    writer = await keyFor('writer', [PluginScopes.ORDERS_READ, PluginScopes.ORDERS_WRITE])
    writerB = await keyFor(
      'writer-b',
      [PluginScopes.ORDERS_READ, PluginScopes.ORDERS_WRITE],
      ctx.storeB.id
    )
    editor = await keyFor('editor', [PluginScopes.ORDERS_READ, PluginScopes.ORDERS_EDIT])
    confirmer = await keyFor('confirmer', [PluginScopes.ORDERS_READ, PluginScopes.ORDERS_CONFIRM])
    canceller = await keyFor('canceller', [PluginScopes.ORDERS_READ, PluginScopes.ORDERS_CANCEL])
    approver = await keyFor('approver', [
      PluginScopes.ORDERS_READ,
      PluginScopes.ORDERS_APPROVE_PRICE
    ])
    otherApprover = await keyFor('approver-2', [
      PluginScopes.ORDERS_READ,
      PluginScopes.ORDERS_APPROVE_PRICE
    ])
    messenger = await keyFor('messenger', [
      PluginScopes.ORDERS_READ,
      PluginScopes.ORDER_MESSAGES_WRITE
    ])
    templater = await keyFor('templater', [
      PluginScopes.ORDER_MESSAGES_READ,
      PluginScopes.ORDER_TEMPLATES_WRITE
    ])
    reader = await keyFor('reader', [PluginScopes.ORDERS_READ])
    editorB = await keyFor(
      'editor-b',
      [PluginScopes.ORDERS_READ, PluginScopes.ORDERS_EDIT],
      ctx.storeB.id
    )
  })
  afterAll(async () => {
    await owner.pluginInstallation.deleteMany({ where: { pluginId: { startsWith: prefix } } })
    await owner.plugin.deleteMany({ where: { id: { startsWith: prefix } } })
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })
  afterEach(async () => {
    await kit.resetSettings()
  })

  const call = (method: 'get' | 'post' | 'patch' | 'put' | 'delete', path: string, key: string) => {
    const server = app.getHttpServer() as Parameters<typeof supertest>[0]
    return supertest(server)
      [method](`${API_PREFIX}${path}`)
      .set('x-forwarded-for', `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`)
      .set('authorization', `Bearer ${key}`)
  }
  const codeOf = (body: unknown) => (body as ErrorBody).error.code
  const rowOf = (orderId: string) => owner.order.findUniqueOrThrow({ where: { id: orderId } })
  const movementsOf = (orderId: string) =>
    owner.inventoryMovement.findMany({ where: { referenceId: orderId } })

  // An order made by a person (the admin), the way the screens make it
  async function placed(quantity = 2, extra: Record<string, unknown> = {}) {
    const product = await kit.stocked(10)
    const body = await kit.orderBody({ items: [{ productId: product.id, quantity }], ...extra })
    const response = await kit.asAdmin().post(ApiRoutes.orders.create).send(body)
    expect(response.status).toBe(CREATED)
    const order = (response.body as { order: { id: string } }).order
    return { order, product }
  }
  async function pluginBody(quantity = 2) {
    const product = await kit.stocked(10)
    return {
      product,
      body: await kit.orderBody({ items: [{ productId: product.id, quantity }] })
    }
  }

  describe('creating an order', () => {
    it('records the plugin as its author and never a person, in the order, the stock and the audit', async () => {
      const { product, body } = await pluginBody()

      const response = await call('post', PluginApiRoutes.orders.create, writer.key).send(body)

      expect(response.status).toBe(CREATED)
      const created = response.body as CreatedBody
      const row = await rowOf(created.order.id)
      expect(row.createdBy).toBeNull()
      expect(row.createdByPluginId).toBe(pluginIdOf('writer'))
      expect(row.storeId).toBe(ctx.storeA.id)
      // The stock was reserved with the same rules as for a person, and says who did it
      const movements = await movementsOf(created.order.id)
      expect(movements.length).toBeGreaterThan(0)
      for (const movement of movements) {
        expect(movement.type).toBe(InventoryMovementType.RESERVE)
        expect(movement.createdBy).toBeNull()
        expect(movement.createdByPluginId).toBe(pluginIdOf('writer'))
      }
      expect((await kit.level(product.id, ctx.warehouseA.id))?.reserved).toBe(2)
      // The audit entry is the platform's, with the installation in its metadata: `user_id` is a foreign key to users
      const [entry] = await waitForAuditEntries(owner, {
        action: AuditAction.ORDER_CREATED,
        resourceId: created.order.id
      })
      expect(entry?.userId).toBeNull()
      expect(entry?.metadata).toMatchObject({ pluginInstallationId: writer.installationId })
    })

    it('answers the allowlist: no customer, no notes, no person of the team', async () => {
      const { body } = await pluginBody()

      const response = await call('post', PluginApiRoutes.orders.create, writer.key).send({
        ...body,
        customerNotes: 'leave it at the door'
      })

      expect(response.status).toBe(CREATED)
      const order = (response.body as CreatedBody).order
      for (const hidden of [
        'customer',
        'customerId',
        'internalNotes',
        'packingNotes',
        'createdBy',
        'confirmedBy',
        'createdByPluginId'
      ] as const) {
        expect(order[hidden]).toBeUndefined()
      }
    })

    it('refuses the fields a plugin does not write, each with a 400', async () => {
      const { body } = await pluginBody()

      for (const extra of [
        { internalNotes: 'x' },
        { packingNotes: 'x' },
        { conversationId: randomUUID() },
        { sendConfirmationMessage: true }
      ]) {
        const response = await call('post', PluginApiRoutes.orders.create, writer.key).send({
          ...body,
          ...extra
        })
        expect(response.status).toBe(BAD_REQUEST)
      }
    })

    it('does not confirm at creation: confirming is the scope orders:confirm', async () => {
      const { body } = await pluginBody()

      const response = await call('post', PluginApiRoutes.orders.create, writer.key).send({
        ...body,
        confirmOnCreate: true
      })

      expect(response.status).toBe(FORBIDDEN)
    })

    it('does not override a price: no scope grants it', async () => {
      const product = await kit.stocked(10)
      const body = await kit.orderBody({
        items: [{ productId: product.id, quantity: 1, unitPriceCents: 1, priceReason: 'a friend' }]
      })

      const response = await call('post', PluginApiRoutes.orders.create, writer.key).send(body)

      expect(response.status).toBe(FORBIDDEN)
      expect(codeOf(response.body)).toBe(ErrorCodes.ORDER_PRICE_OVERRIDE_FORBIDDEN)
    })

    it('refuses a customer of another store, as for a person', async () => {
      const { body } = await pluginBody()
      const strangers = await call('post', PluginApiRoutes.orders.create, writerB.key).send(body)

      expect(strangers.status).toBe(NOT_FOUND)
    })

    it('keeps the stock rule: no stock, no order, and nothing is written', async () => {
      const product = await kit.stocked(1)
      const body = await kit.orderBody({ items: [{ productId: product.id, quantity: 5 }] })
      const before = await owner.order.count({ where: { storeId: ctx.storeA.id } })

      const response = await call('post', PluginApiRoutes.orders.create, writer.key).send(body)

      expect(response.status).toBeGreaterThanOrEqual(BAD_REQUEST)
      expect(await owner.order.count({ where: { storeId: ctx.storeA.id } })).toBe(before)
    })
  })

  describe('the scopes', () => {
    it('opens each write only to the scope that names it', async () => {
      const { order } = await placed()
      const denied = [
        // orders:write creates and changes the status, nothing else
        call('patch', PluginApiRoutes.orders.byId(order.id), writer.key).send({ shippingCents: 5 }),
        call('post', PluginApiRoutes.orders.cancel(order.id), writer.key).send({
          cancellationReason: 'no'
        }),
        call('post', PluginApiRoutes.orders.confirm(order.id), writer.key).send({
          via: OrderConfirmationChannel.CALL
        }),
        call('post', PluginApiRoutes.orders.priceApprovalApprove(order.id), writer.key).send({}),
        call('post', PluginApiRoutes.orders.messages(order.id), writer.key).send({
          kind: OrderMessageKind.ORDER_SHIPPED,
          idempotencyKey: randomUUID()
        }),
        // orders:read reads
        call('post', PluginApiRoutes.orders.create, reader.key).send({}),
        call('post', PluginApiRoutes.orders.status(order.id), reader.key).send({
          status: OrderStatus.PREPARING
        }),
        // each of the others is its own
        call('post', PluginApiRoutes.orders.create, editor.key).send({}),
        call('post', PluginApiRoutes.orders.cancel(order.id), confirmer.key).send({
          cancellationReason: 'no'
        }),
        call('post', PluginApiRoutes.orders.confirm(order.id), canceller.key).send({
          via: OrderConfirmationChannel.CALL
        }),
        call('patch', PluginApiRoutes.orders.byId(order.id), canceller.key).send({
          shippingCents: 5
        }),
        call('post', PluginApiRoutes.orders.priceApprovalReject(order.id), editor.key).send({}),
        call(
          'put',
          PluginApiRoutes.orderTemplates.byKindAndLocale('order_shipped', Locales.ES),
          messenger.key
        ).send({
          body: 'x'
        })
      ]
      for (const request of denied) {
        const response = await request
        expect(response.status).toBe(FORBIDDEN)
        expect(codeOf(response.body)).toBe(ErrorCodes.PLUGIN_SCOPE_DENIED)
      }
      expect((await rowOf(order.id)).status).toBe(OrderStatus.PENDING_CONFIRMATION)
    })

    it('refuses confirming or cancelling through the status route to a key that has only orders:write', async () => {
      const { order } = await placed()

      const confirm = await call('post', PluginApiRoutes.orders.status(order.id), writer.key).send({
        status: OrderStatus.CONFIRMED
      })
      const cancel = await call('post', PluginApiRoutes.orders.status(order.id), writer.key).send({
        status: OrderStatus.CANCELLED,
        cancellationReason: 'no'
      })

      expect(confirm.status).toBe(FORBIDDEN)
      expect(cancel.status).toBe(FORBIDDEN)
      // The refusal names the route that does the work, not only the permission the key already has as a scope
      expect(JSON.stringify(confirm.body)).toContain('through its confirm route')
      expect(JSON.stringify(cancel.body)).toContain('through its cancel route')
      expect((await rowOf(order.id)).status).toBe(OrderStatus.PENDING_CONFIRMATION)
    })

    it('does not move an order of another store (the key names the store)', async () => {
      const { order } = await placed()

      const response = await call('patch', PluginApiRoutes.orders.byId(order.id), editorB.key).send(
        {
          shippingCents: 5
        }
      )

      expect(response.status).toBe(NOT_FOUND)
    })
  })

  describe('confirming and cancelling', () => {
    it('confirms as the plugin and records it in the order and the audit', async () => {
      const { order } = await placed()

      const response = await call(
        'post',
        PluginApiRoutes.orders.confirm(order.id),
        confirmer.key
      ).send({
        via: OrderConfirmationChannel.CALL
      })

      expect(response.status).toBe(OK)
      expect((response.body as PluginOrderBody).status).toBe(OrderStatus.CONFIRMED)
      const row = await rowOf(order.id)
      expect(row.confirmedBy).toBeNull()
      expect(row.confirmedByPluginId).toBe(pluginIdOf('confirmer'))
      const entries = await waitForAuditEntries(owner, {
        action: AuditAction.ORDER_CONFIRMED,
        resourceId: order.id
      })
      expect(entries[0]?.userId).toBeNull()
      expect(entries[0]?.metadata).toMatchObject({ pluginInstallationId: confirmer.installationId })
    })

    it('confirms a selection, each order of its own', async () => {
      const first = (await placed()).order
      const second = (await placed()).order

      const response = await call('post', PluginApiRoutes.orders.confirmBulk, confirmer.key).send({
        ids: [first.id, second.id],
        via: OrderConfirmationChannel.OTHER
      })

      expect(response.status).toBe(OK)
      expect((response.body as { succeeded: string[] }).succeeded.sort()).toEqual(
        [first.id, second.id].sort()
      )
      expect((await rowOf(first.id)).confirmedByPluginId).toBe(pluginIdOf('confirmer'))
    })

    it('cancels as the plugin, puts the stock back and says who in every record', async () => {
      const { order, product } = await placed(3)
      expect((await kit.level(product.id, ctx.warehouseA.id))?.reserved).toBe(3)

      const response = await call(
        'post',
        PluginApiRoutes.orders.cancel(order.id),
        canceller.key
      ).send({
        cancellationReason: 'the customer changed their mind'
      })

      expect(response.status).toBe(OK)
      const row = await rowOf(order.id)
      expect(row.status).toBe(OrderStatus.CANCELLED)
      expect(row.cancelledBy).toBeNull()
      expect(row.cancelledByPluginId).toBe(pluginIdOf('canceller'))
      expect((await kit.level(product.id, ctx.warehouseA.id))?.reserved).toBe(0)
      const released = (await movementsOf(order.id)).filter(
        movement => movement.type === String(InventoryMovementType.RELEASE)
      )
      expect(released.length).toBeGreaterThan(0)
      for (const movement of released) {
        expect(movement.createdBy).toBeNull()
        expect(movement.createdByPluginId).toBe(pluginIdOf('canceller'))
      }
      const entries = await waitForAuditEntries(owner, {
        action: AuditAction.ORDER_CANCELLED,
        resourceId: order.id
      })
      expect(entries[0]?.userId).toBeNull()
    })

    it('keeps the rules of the status: a cancelled order is not confirmed again', async () => {
      const { order } = await placed()
      await call('post', PluginApiRoutes.orders.cancel(order.id), canceller.key).send({
        cancellationReason: 'no'
      })

      const response = await call(
        'post',
        PluginApiRoutes.orders.confirm(order.id),
        confirmer.key
      ).send({
        via: OrderConfirmationChannel.CALL
      })

      expect(response.status).toBeGreaterThanOrEqual(BAD_REQUEST)
      expect((await rowOf(order.id)).status).toBe(OrderStatus.CANCELLED)
    })
  })

  describe('editing and the payment', () => {
    it('edits the lines of an order, moving the stock with the plugin as who did it', async () => {
      const { order, product } = await placed(2)

      const response = await call('patch', PluginApiRoutes.orders.byId(order.id), editor.key).send({
        items: [{ productId: product.id, quantity: 4 }]
      })

      expect(response.status).toBe(OK)
      expect((await kit.level(product.id, ctx.warehouseA.id))?.reserved).toBe(4)
      // The first reservation is the person's who placed the order; the release and the new reservation are the plugin's
      const byPlugin = (await movementsOf(order.id)).filter(m => m.createdByPluginId !== null)
      expect(byPlugin.length).toBeGreaterThan(1)
      for (const movement of byPlugin) {
        expect(movement.createdBy).toBeNull()
        expect(movement.createdByPluginId).toBe(pluginIdOf('editor'))
      }
    })

    it('does not write the notes of the team, the tracking number or a file', async () => {
      const { order } = await placed()

      for (const change of [
        { internalNotes: 'x' },
        { packingNotes: 'x' },
        { trackingNumber: 'ABC123' }
      ]) {
        const response = await call(
          'patch',
          PluginApiRoutes.orders.byId(order.id),
          editor.key
        ).send(change)
        expect(response.status).toBe(BAD_REQUEST)
      }
      const payment = await call('post', PluginApiRoutes.orders.payment(order.id), editor.key).send(
        {
          method: PaymentMethod.TRANSFER,
          status: PaymentStatus.COMPLETED,
          proofMediaId: randomUUID()
        }
      )
      expect(payment.status).toBe(BAD_REQUEST)
    })

    it('records a payment by hand, with the rules of a person: cash on delivery waits for the delivery', async () => {
      const { order: cod } = await placed()
      const early = await call('post', PluginApiRoutes.orders.payment(cod.id), editor.key).send({
        method: PaymentMethod.CASH_ON_DELIVERY,
        status: PaymentStatus.COMPLETED
      })
      expect(early.status).toBe(HttpStatusCodes.CONFLICT)
      const { order } = await placed(2, { paymentMethod: PaymentMethod.TRANSFER })

      const response = await call(
        'post',
        PluginApiRoutes.orders.payment(order.id),
        editor.key
      ).send({
        method: PaymentMethod.TRANSFER,
        status: PaymentStatus.COMPLETED,
        reference: 'TR-1'
      })

      expect(response.status).toBe(OK)
      expect((await rowOf(order.id)).paymentStatus).toBe(PaymentStatus.COMPLETED)
    })
  })

  describe('the price of an order', () => {
    // An order whose price waits for an approval, asked by `requester`
    async function waiting(requester: { userId?: string; pluginId?: string }) {
      const { order } = await placed()
      await owner.order.update({
        where: { id: order.id },
        data: {
          priceApprovalStatus: PriceApprovalStatus.PENDING,
          priceApprovalRequestedBy: requester.userId ?? null,
          priceApprovalRequestedByPluginId: requester.pluginId ?? null
        }
      })
      return order
    }

    it('lets a plugin approve a request that a person made, and records it', async () => {
      const order = await waiting({ userId: ctx.adminA.id })

      const response = await call(
        'post',
        PluginApiRoutes.orders.priceApprovalApprove(order.id),
        approver.key
      ).send({})

      expect(response.status).toBe(OK)
      expect((response.body as PluginOrderBody).priceApprovalStatus).toBe(
        PriceApprovalStatus.APPROVED
      )
      const row = await rowOf(order.id)
      expect(row.priceApprovedBy).toBeNull()
      expect(row.priceApprovedByPluginId).toBe(pluginIdOf('approver'))
    })

    it('does not let a plugin approve the request it made itself, and lets another one', async () => {
      const order = await waiting({ pluginId: pluginIdOf('approver') })

      const own = await call(
        'post',
        PluginApiRoutes.orders.priceApprovalApprove(order.id),
        approver.key
      ).send({})
      const other = await call(
        'post',
        PluginApiRoutes.orders.priceApprovalApprove(order.id),
        otherApprover.key
      ).send({})

      expect(own.status).toBe(FORBIDDEN)
      expect(codeOf(own.body)).toBe(ErrorCodes.ORDER_PRICE_SELF_APPROVAL)
      expect(other.status).toBe(OK)
      expect((await rowOf(order.id)).priceApprovedByPluginId).toBe(pluginIdOf('approver-2'))
    })

    it('rejects a request, and a decision on a price that waits for nothing is refused', async () => {
      const order = await waiting({ userId: ctx.adminA.id })
      const rejected = await call(
        'post',
        PluginApiRoutes.orders.priceApprovalReject(order.id),
        approver.key
      ).send({
        reason: 'too much'
      })
      const { order: plain } = await placed()
      const nothing = await call(
        'post',
        PluginApiRoutes.orders.priceApprovalApprove(plain.id),
        approver.key
      ).send({})

      expect(rejected.status).toBe(OK)
      expect(nothing.status).toBeGreaterThanOrEqual(BAD_REQUEST)
    })
  })

  describe('the messages and the templates', () => {
    it('sends a message about an order with the plugin as who asked, once for each key', async () => {
      const { order } = await placed()
      const idempotencyKey = randomUUID()
      const send = () =>
        call('post', PluginApiRoutes.orders.messages(order.id), messenger.key).send({
          kind: OrderMessageKind.ORDER_SHIPPED,
          idempotencyKey
        })

      const first = await send()
      const second = await send()

      expect(first.status).toBe(OK)
      expect(second.status).toBe(OK)
      const dispatches = await owner.orderMessageDispatch.findMany({
        where: { orderId: order.id, kind: OrderMessageKind.ORDER_SHIPPED }
      })
      expect(dispatches).toHaveLength(1)
      expect(dispatches[0]?.requestedBy).toBeNull()
      expect(dispatches[0]?.requestedByPluginId).toBe(pluginIdOf('messenger'))
    })

    it('requires the key of the call and does not preview', async () => {
      const { order } = await placed()

      const noKey = await call(
        'post',
        PluginApiRoutes.orders.messages(order.id),
        messenger.key
      ).send({
        kind: OrderMessageKind.ORDER_SHIPPED
      })
      const preview = await call(
        'post',
        `${PluginApiRoutes.orders.messages(order.id)}?preview=true`,
        messenger.key
      ).send({
        kind: OrderMessageKind.ORDER_SHIPPED
      })

      expect(noKey.status).toBe(BAD_REQUEST)
      expect(preview.status).toBe(BAD_REQUEST)
      expect(
        await owner.orderMessageDispatch.count({
          where: { orderId: order.id, kind: OrderMessageKind.ORDER_SHIPPED }
        })
      ).toBe(0)
    })

    it('does not turn ?preview=true into a real send', async () => {
      const { order } = await placed()

      const response = await call(
        'post',
        `${PluginApiRoutes.orders.messages(order.id)}?preview=true`,
        messenger.key
      ).send({ kind: OrderMessageKind.ORDER_SHIPPED, idempotencyKey: randomUUID() })

      expect(response.status).toBe(BAD_REQUEST)
      expect(
        await owner.orderMessageDispatch.count({
          where: { orderId: order.id, kind: OrderMessageKind.ORDER_SHIPPED }
        })
      ).toBe(0)
    })

    it('writes, previews and deletes a template, audited as the plugin', async () => {
      const path = PluginApiRoutes.orderTemplates.byKindAndLocale(
        OrderMessageKind.ORDER_SHIPPED,
        Locales.ES
      )

      const preview = await call(
        'post',
        PluginApiRoutes.orderTemplates.preview,
        templater.key
      ).send({
        body: 'Hola {{customerName}}',
        locale: Locales.ES
      })
      const autoSend = await call('put', path, templater.key).send({
        body: 'Hola {{customerName}}',
        autoSend: true
      })
      expect(autoSend.status).toBe(BAD_REQUEST)
      const saved = await call('put', path, templater.key).send({
        body: 'Hola {{customerName}}, va en camino'
      })
      const removed = await call('delete', path, templater.key)

      expect(preview.status).toBe(OK)
      expect(saved.status).toBe(OK)
      expect(removed.status).toBe(NO_CONTENT)
      const entries = await waitForAuditEntries(owner, {
        action: AuditAction.ORDER_TEMPLATE_UPDATED,
        storeId: ctx.storeA.id,
        resourceId: `${OrderMessageKind.ORDER_SHIPPED}:${Locales.ES}`
      })
      expect(entries[0]?.userId).toBeNull()
      expect(entries[0]?.metadata).toMatchObject({ pluginInstallationId: templater.installationId })
    })

    it('keeps what the store chose when a plugin puts only a text: autoSend and the summary stay (N-AA-04)', async () => {
      const path = PluginApiRoutes.orderTemplates.byKindAndLocale(
        OrderMessageKind.ORDER_DELIVERED,
        Locales.EN
      )
      try {
        await owner.orderMessageTemplate.deleteMany({
          where: {
            storeId: ctx.storeA.id,
            kind: OrderMessageKind.ORDER_DELIVERED,
            locale: Locales.EN
          }
        })
        await owner.orderMessageTemplate.create({
          data: {
            storeId: ctx.storeA.id,
            kind: OrderMessageKind.ORDER_DELIVERED,
            locale: Locales.EN,
            body: 'Delivered {{orderNumber}}',
            autoSend: true,
            attachSummary: true
          }
        })

        const saved = await call('put', path, templater.key).send({ body: 'Your order arrived' })

        expect(saved.status).toBe(OK)
        const row = await owner.orderMessageTemplate.findFirstOrThrow({
          where: {
            storeId: ctx.storeA.id,
            kind: OrderMessageKind.ORDER_DELIVERED,
            locale: Locales.EN
          }
        })
        expect([row.body, row.autoSend, row.attachSummary]).toEqual([
          'Your order arrived',
          true,
          true
        ])
        // A template the plugin creates starts with the defaults of its kind
        await owner.orderMessageTemplate.deleteMany({ where: { id: row.id } })
        const created = await call('put', path, templater.key).send({ body: 'Arrived' })
        expect(created.status).toBe(OK)
        const fresh = await owner.orderMessageTemplate.findFirstOrThrow({
          where: {
            storeId: ctx.storeA.id,
            kind: OrderMessageKind.ORDER_DELIVERED,
            locale: Locales.EN
          }
        })
        expect(fresh.attachSummary).toBe(false)
        await owner.orderMessageTemplate.deleteMany({ where: { id: fresh.id } })
      } finally {
        await owner.orderMessageTemplate.deleteMany({
          where: {
            storeId: ctx.storeA.id,
            kind: OrderMessageKind.ORDER_DELIVERED,
            locale: Locales.EN
          }
        })
      }
    })
  })

  describe('the copy of an order', () => {
    it('needs the scope of each thing the draft carries, and leaves out the notes', async () => {
      const { order } = await placed()
      const full = await keyFor('copier', [
        PluginScopes.ORDERS_READ,
        PluginScopes.ORDERS_WRITE,
        PluginScopes.CUSTOMERS_READ,
        PluginScopes.PRODUCTS_READ
      ])
      await owner.order.update({
        where: { id: order.id },
        data: { internalNotes: 'secret', packingNotes: 'fragile', customerNotes: 'hello' }
      })

      const denied = await call('get', PluginApiRoutes.orders.copy(order.id), writer.key)
      const allowed = await call('get', PluginApiRoutes.orders.copy(order.id), full.key)

      expect(denied.status).toBe(FORBIDDEN)
      expect(allowed.status).toBe(OK)
      const text = JSON.stringify(allowed.body)
      expect(text).not.toContain('secret')
      expect(text).not.toContain('fragile')
      expect(text).not.toContain('hello')
    })
  })

  describe('the database', () => {
    it('refuses an order made by a person and by a plugin at once, and one made by none', async () => {
      const { order } = await placed()
      const base = await rowOf(order.id)

      await expect(
        owner.order.update({
          where: { id: order.id },
          data: { createdByPluginId: 'a-plugin' }
        })
      ).rejects.toThrow()
      await expect(
        owner.order.update({
          where: { id: order.id },
          data: { createdBy: null }
        })
      ).rejects.toThrow()
      expect((await rowOf(order.id)).createdBy).toBe(base.createdBy)
    })
  })
})
